import { openIndexedDbAtLeast } from "@/lib/idb-open";

/**
 * 档位系统的独立存储层。
 *
 * 档位数据（快照 + 注册表）放在一个独立的 IndexedDB（AiPhoneSlotDB），与主数据
 * 完全隔离——这样：
 * - 数据备份 / 导入 / 清理（lib/data-management）永远不会碰档位数据；
 * - 切换档位清空主数据时，档位快照本身不受影响；
 * - “在哪个档位导出的备份就是哪个档位的备份”天然成立（导出的始终是 live 数据）。
 */

const SLOT_DB_NAME = "AiPhoneSlotDB";
const SLOT_DB_VERSION = 1;
const META_STORE = "meta";
const SNAPSHOT_STORE = "snapshots";
const REGISTRY_KEY = "registry";

export type SlotMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 是否已经有快照数据（false = 新建后从未归档过的空白档位） */
  hasData: boolean;
  /** 快照文件大小（字节；空白档位为 0） */
  bytes: number;
  /** 快照记录条数（展示用） */
  records: number;
  /** 最近一次归档 / 切换进入的时间 */
  lastUsedAt?: string;
};

export type SlotRegistry = {
  currentSlotId: string | null;
  slots: SlotMeta[];
};

export type SlotSnapshotRecord = {
  id: string;
  blob: Blob;
  createdAt: string;
};

function hasIndexedDb(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function openSlotDb(): Promise<IDBDatabase> {
  return openIndexedDbAtLeast(SLOT_DB_NAME, SLOT_DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(META_STORE)) {
      db.createObjectStore(META_STORE, { keyPath: "key" });
    }
    if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
      db.createObjectStore(SNAPSHOT_STORE, { keyPath: "id" });
    }
  });
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function normalizeRegistry(value: unknown): SlotRegistry {
  if (!value || typeof value !== "object") return { currentSlotId: null, slots: [] };
  const raw = value as Partial<SlotRegistry>;
  const slots: SlotMeta[] = Array.isArray(raw.slots)
    ? raw.slots
        .filter((slot): slot is SlotMeta =>
          Boolean(slot && typeof slot === "object" && typeof (slot as SlotMeta).id === "string"))
        .map((slot) => ({
          id: slot.id,
          name: typeof slot.name === "string" && slot.name ? slot.name : "未命名档位",
          createdAt: typeof slot.createdAt === "string" ? slot.createdAt : new Date().toISOString(),
          updatedAt: typeof slot.updatedAt === "string" ? slot.updatedAt : new Date().toISOString(),
          hasData: Boolean(slot.hasData),
          bytes: Number.isFinite(slot.bytes) ? Number(slot.bytes) : 0,
          records: Number.isFinite(slot.records) ? Number(slot.records) : 0,
          lastUsedAt: typeof slot.lastUsedAt === "string" ? slot.lastUsedAt : undefined,
        }))
    : [];
  const currentSlotId =
    typeof raw.currentSlotId === "string" && slots.some((slot) => slot.id === raw.currentSlotId)
      ? raw.currentSlotId
      : null;
  return { currentSlotId, slots };
}

export async function readSlotRegistry(): Promise<SlotRegistry> {
  if (!hasIndexedDb()) return { currentSlotId: null, slots: [] };
  try {
    const db = await openSlotDb();
    try {
      const tx = db.transaction(META_STORE, "readonly");
      const record = await runRequest(tx.objectStore(META_STORE).get(REGISTRY_KEY));
      if (!record || typeof record !== "object" || !("value" in record)) {
        return { currentSlotId: null, slots: [] };
      }
      return normalizeRegistry((record as { value: unknown }).value);
    } finally {
      db.close();
    }
  } catch {
    return { currentSlotId: null, slots: [] };
  }
}

export async function writeSlotRegistry(registry: SlotRegistry): Promise<void> {
  const db = await openSlotDb();
  try {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ key: REGISTRY_KEY, value: registry });
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function putSlotSnapshot(id: string, blob: Blob): Promise<void> {
  const db = await openSlotDb();
  try {
    const tx = db.transaction(SNAPSHOT_STORE, "readwrite");
    const record: SlotSnapshotRecord = { id, blob, createdAt: new Date().toISOString() };
    tx.objectStore(SNAPSHOT_STORE).put(record);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function getSlotSnapshotBlob(id: string): Promise<Blob | null> {
  if (!hasIndexedDb()) return null;
  try {
    const db = await openSlotDb();
    try {
      const tx = db.transaction(SNAPSHOT_STORE, "readonly");
      const record = await runRequest(tx.objectStore(SNAPSHOT_STORE).get(id));
      if (!record || typeof record !== "object") return null;
      const blob = (record as Partial<SlotSnapshotRecord>).blob;
      return blob instanceof Blob ? blob : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function removeSlotSnapshot(id: string): Promise<void> {
  const db = await openSlotDb();
  try {
    const tx = db.transaction(SNAPSHOT_STORE, "readwrite");
    tx.objectStore(SNAPSHOT_STORE).delete(id);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}
