import type { DataModuleId, ImportResult } from "@/lib/data-management/types";
import {
  clearModules,
  createBackupBlob,
  downloadBackupBlob,
  importBackupBlob,
} from "@/lib/data-management/backup";
import { DATA_MODULES } from "@/lib/data-management/modules";
import {
  getSlotSnapshotBlob,
  putSlotSnapshot,
  readSlotRegistry,
  removeSlotSnapshot,
  writeSlotRegistry,
  type SlotMeta,
  type SlotRegistry,
} from "@/lib/slot-storage";

/**
 * 档位业务层：创建 / 重命名 / 删除 / 归档 / 切换 / 导出。
 *
 * 数据流（与 Mji 的档位系统同思路）：
 * - live 数据 = 当前设备的全部主数据（chat / settings / characters / … 共 10 个模块）；
 * - 档位快照 = 一份完整的备份 zip，存在独立库 AiPhoneSlotDB 里；
 * - 切换 = 归档当前档位 → 清空 live → 恢复目标档位快照 → 重启应用；
 * - 新建档位 = 空白（没有快照），切进去就是全新默认状态；
 * - 导出 = 导出 live 数据，即“在哪个档位导出，得到的就是哪个档位的备份”。
 */

export const ALL_SLOT_MODULE_IDS: DataModuleId[] = DATA_MODULES.map((module) => module.id);

const MAX_SLOT_NAME_LENGTH = 30;

/** 把名字里会影响文件名的字符替换掉（导出档位备份时用） */
export function sanitizeSlotNameForFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, MAX_SLOT_NAME_LENGTH) || "档位";
}

function normalizeSlotName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_SLOT_NAME_LENGTH);
  return name || "未命名档位";
}

function createSlotId(): string {
  return `slot_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function listSlots(): Promise<SlotRegistry> {
  return readSlotRegistry();
}

export async function createSlot(name: string): Promise<SlotMeta> {
  const registry = await readSlotRegistry();
  const now = new Date().toISOString();
  const meta: SlotMeta = {
    id: createSlotId(),
    name: normalizeSlotName(name),
    createdAt: now,
    updatedAt: now,
    hasData: false,
    bytes: 0,
    records: 0,
  };
  registry.slots.push(meta);
  await writeSlotRegistry(registry);
  return meta;
}

export async function renameSlot(id: string, name: string): Promise<void> {
  const registry = await readSlotRegistry();
  const meta = registry.slots.find((slot) => slot.id === id);
  if (!meta) throw new Error("档位不存在。");
  meta.name = normalizeSlotName(name);
  meta.updatedAt = new Date().toISOString();
  await writeSlotRegistry(registry);
}

export async function deleteSlot(id: string): Promise<void> {
  const registry = await readSlotRegistry();
  if (registry.currentSlotId === id) {
    throw new Error("当前正在使用的档位不能删除，请先切换到其他档位。");
  }
  if (!registry.slots.some((slot) => slot.id === id)) throw new Error("档位不存在。");
  registry.slots = registry.slots.filter((slot) => slot.id !== id);
  await writeSlotRegistry(registry);
  await removeSlotSnapshot(id);
}

export type ArchiveResult = {
  bytes: number;
  records: number;
  warnings: string[];
};

/** 把当前 live 数据完整归档到指定档位（覆盖其旧快照）。 */
export async function archiveCurrentToSlot(slotId: string): Promise<ArchiveResult> {
  const { blob, manifest, warnings } = await createBackupBlob();
  const bytes = blob.size;
  const records = manifest.totalRecords;
  await putSlotSnapshot(slotId, blob);
  const registry = await readSlotRegistry();
  const meta = registry.slots.find((slot) => slot.id === slotId);
  if (meta) {
    const now = new Date().toISOString();
    meta.hasData = true;
    meta.bytes = bytes;
    meta.records = records;
    meta.updatedAt = now;
    meta.lastUsedAt = now;
    await writeSlotRegistry(registry);
  }
  return { bytes, records, warnings };
}

/**
 * 把当前 live 数据保存为一个新档位，并把它设为“当前档位”。
 * 用于首次启用档位功能时，把设备上已有的数据落位到第一个档位。
 */
export async function saveCurrentAsNewSlot(name: string): Promise<SlotMeta> {
  const meta = await createSlot(name);
  try {
    await archiveCurrentToSlot(meta.id);
  } catch (error) {
    // 归档失败 → 回滚刚创建的空档位，避免留下误导性的空壳。
    try {
      await deleteSlot(meta.id);
    } catch {
      // 忽略回滚失败；原始错误更重要。
    }
    throw error;
  }
  const registry = await readSlotRegistry();
  registry.currentSlotId = meta.id;
  const saved = registry.slots.find((slot) => slot.id === meta.id);
  if (saved) saved.lastUsedAt = new Date().toISOString();
  await writeSlotRegistry(registry);
  return saved ?? meta;
}

export type SwitchStep = "archive" | "clear" | "restore" | "finalize";

export type SwitchResult = {
  targetName: string;
  /** 切换前把当前数据归档到了哪个档位（没有则不归档） */
  archivedTo: string | null;
  /** 清掉的 live 记录数 */
  clearedRecords: number;
  /** 目标档位快照的导入结果（空白档位为 null） */
  imported: ImportResult | null;
  /** 过程中的非致命警告 */
  warnings: string[];
};

/**
 * 切换档位：归档当前 → 清空 live → 恢复目标。
 * 切换完成后必须彻底重启应用（沿用数据管理的重启机制）。
 */
export async function switchSlot(
  targetId: string,
  onProgress?: (step: SwitchStep) => void,
): Promise<SwitchResult> {
  const registry = await readSlotRegistry();
  const target = registry.slots.find((slot) => slot.id === targetId);
  if (!target) throw new Error("目标档位不存在。");
  if (registry.currentSlotId === targetId) throw new Error("已经在这个档位里了。");

  const warnings: string[] = [];

  // 1) 归档当前。若 live 数据还没有归属档位（首次启用），自动先存为“自动存档”，
  //    绝不静默丢数据。
  let archivedTo: string | null = null;
  onProgress?.("archive");
  if (registry.currentSlotId) {
    const current = registry.slots.find((slot) => slot.id === registry.currentSlotId);
    const archived = await archiveCurrentToSlot(registry.currentSlotId);
    warnings.push(...archived.warnings);
    archivedTo = current?.name ?? null;
  } else {
    const saved = await createSlot("自动存档");
    await archiveCurrentToSlot(saved.id);
    archivedTo = saved.name;
  }

  // 2) 清空 live 数据。
  onProgress?.("clear");
  const cleared = await clearModules(ALL_SLOT_MODULE_IDS);
  if (cleared.errors.length > 0) {
    warnings.push(...cleared.errors);
  }

  // 3) 恢复目标档位（空白档位没有快照，跳过）。
  onProgress?.("restore");
  const blob = await getSlotSnapshotBlob(targetId);
  let imported: ImportResult | null = null;
  if (blob) {
    imported = await importBackupBlob(blob, ALL_SLOT_MODULE_IDS, { overwrite: true });
    if (imported.errors.length > 0) {
      warnings.push(...imported.errors);
    }
    if (imported.added === 0 && imported.overwritten === 0 && imported.errors.length > 0) {
      throw new Error(`目标档位快照载入失败：${imported.errors[0]}`);
    }
  }

  // 4) 落到注册表。
  onProgress?.("finalize");
  const registryAfter = await readSlotRegistry();
  registryAfter.currentSlotId = targetId;
  const meta = registryAfter.slots.find((slot) => slot.id === targetId);
  if (meta) {
    meta.lastUsedAt = new Date().toISOString();
  }
  await writeSlotRegistry(registryAfter);

  return {
    targetName: target.name,
    archivedTo,
    clearedRecords: cleared.removed,
    imported,
    warnings,
  };
}

export type ExportSlotResult = {
  modules: number;
  bytes: number;
  warnings: string[];
  filenameSlotName: string | null;
};

/** 导出当前档位备份（导出内容就是当前 live 数据 = 当前档位的数据）。 */
export async function exportCurrentSlotBackup(): Promise<ExportSlotResult> {
  const registry = await readSlotRegistry();
  const current = registry.slots.find((slot) => slot.id === registry.currentSlotId) ?? null;
  const { blob, manifest, warnings } = await createBackupBlob(ALL_SLOT_MODULE_IDS, {
    includeCloudCredentials: true,
  });
  const prefix = current ? sanitizeSlotNameForFilename(current.name) : undefined;
  await downloadBackupBlob(blob, manifest, {}, prefix);
  return {
    modules: manifest.modules.length,
    bytes: manifest.totalBytes,
    warnings,
    filenameSlotName: current?.name ?? null,
  };
}