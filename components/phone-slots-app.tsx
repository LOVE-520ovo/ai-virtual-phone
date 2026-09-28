"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  Archive,
  ArrowRightLeft,
  Download,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { ConfirmDialog, ContentDialog } from "@/components/ui/modal";
import { Input } from "@/components/ui/form";
import { formatBytes } from "@/lib/data-management/backup";
import { getRuntimePwaDisplayMode } from "@/lib/pwa-display-mode";
import {
  archiveCurrentToSlot,
  createSlot,
  deleteSlot,
  exportCurrentSlotBackup,
  listSlots,
  renameSlot,
  saveCurrentAsNewSlot,
  switchSlot,
  type SwitchStep,
} from "@/lib/slot-manager";
import type { SlotMeta, SlotRegistry } from "@/lib/slot-storage";

type PhoneSlotsAppProps = {
  onClose: () => void;
  onNotice: (text: string) => void;
};

type DialogState =
  | { type: "create-empty" }
  | { type: "save-current" }
  | { type: "rename"; slot: SlotMeta }
  | { type: "delete"; slot: SlotMeta }
  | { type: "switch"; slot: SlotMeta }
  | null;

type BusyState = { label: string } | null;

type RestartNotice = { title: string; summary: string };

const SWITCH_STEP_LABELS: Record<SwitchStep, string> = {
  archive: "正在归档当前档位…",
  clear: "正在清空当前数据…",
  restore: "正在载入目标档位…",
  finalize: "正在收尾…",
};

const SMALL_BUTTON_CLASS = "ui-btn ui-btn-outline py-1 px-3 ts-12";
const SMALL_DANGER_BUTTON_CLASS = "ui-btn ui-btn-danger py-1 px-3 ts-12";

const dialogDescStyle: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.6,
  color: "var(--c-text)",
  margin: "0 0 10px",
};

function formatTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * 切换 / 导入类操作之后必须彻底重启应用（与数据管理同一机制）：
 * kv 层是「IndexedDB + 同步内存缓存」，留在当前页面不仅看到的还是旧数据，
 * 接下来任何一次写入都会用内存里的旧值把刚恢复的数据覆盖掉。
 */
function buildRestartMessage(summary: string): string {
  const standalone = typeof window !== "undefined" && getRuntimePwaDisplayMode() !== "browser";
  const howTo = standalone
    ? "请彻底关闭应用（从系统后台任务列表里划掉），然后重新打开。"
    : "请彻底重启应用：点下方按钮，或手动关掉页面重新进入。";
  return `${summary}\n\n数据已经写进本机，但当前页面还在用重启前的旧缓存运行。${howTo}\n\n在重启之前继续使用，可能让旧缓存把刚切换好的数据重新覆盖掉。`;
}

export function PhoneSlotsApp({ onClose, onNotice }: PhoneSlotsAppProps) {
  const [registry, setRegistry] = useState<SlotRegistry | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState<BusyState>(null);
  const [restartNotice, setRestartNotice] = useState<RestartNotice | null>(null);

  const refresh = useCallback(async () => {
    const next = await listSlots();
    setRegistry(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentSlot = registry?.slots.find((slot) => slot.id === registry.currentSlotId) ?? null;

  const runAction = useCallback(
    async (label: string, action: () => Promise<string>) => {
      setBusy({ label });
      try {
        const message = await action();
        onNotice(message);
      } catch (error) {
        onNotice(error instanceof Error ? error.message : "操作失败。");
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [onNotice, refresh],
  );

  const closeDialog = () => setDialog(null);

  const openCreateEmpty = () => {
    setNameInput(`档位${(registry?.slots.length ?? 0) + 1}`);
    setDialog({ type: "create-empty" });
  };

  const openSaveCurrent = () => {
    setNameInput(`档位${(registry?.slots.length ?? 0) + 1}`);
    setDialog({ type: "save-current" });
  };

  const openRename = (slot: SlotMeta) => {
    setNameInput(slot.name);
    setDialog({ type: "rename", slot });
  };

  const handleCreateEmpty = () => {
    const name = nameInput;
    closeDialog();
    void runAction("正在创建档位…", async () => {
      const meta = await createSlot(name);
      return `已创建空白档位『${meta.name}』。切换过去就是全新的默认状态。`;
    });
  };

  const handleSaveCurrent = () => {
    const name = nameInput;
    closeDialog();
    void runAction("正在保存当前数据…", async () => {
      const meta = await saveCurrentAsNewSlot(name);
      return `当前数据已保存为档位『${meta.name}』，并设为当前档位。`;
    });
  };

  const handleRename = (slot: SlotMeta) => {
    const name = nameInput;
    closeDialog();
    void runAction("正在重命名…", async () => {
      await renameSlot(slot.id, name);
      return "已重命名档位。";
    });
  };

  const handleDelete = (slot: SlotMeta) => {
    closeDialog();
    void runAction("正在删除档位…", async () => {
      await deleteSlot(slot.id);
      return `已删除档位『${slot.name}』。`;
    });
  };

  const handleSaveProgress = () => {
    if (!currentSlot) return;
    void runAction("正在保存当前进度…", async () => {
      const result = await archiveCurrentToSlot(currentSlot.id);
      return `已把当前进度保存到『${currentSlot.name}』（${formatBytes(result.bytes)}）。`;
    });
  };

  const handleExport = () => {
    void runAction("正在导出当前档位备份…", async () => {
      const result = await exportCurrentSlotBackup();
      const label = result.filenameSlotName ? `『${result.filenameSlotName}』` : "当前数据";
      return `已导出${label}的备份（${formatBytes(result.bytes)}），可在「文件管理 → 下载」里找到。`;
    });
  };

  const handleSwitch = (slot: SlotMeta) => {
    closeDialog();
    void (async () => {
      setBusy({ label: SWITCH_STEP_LABELS.archive });
      try {
        const result = await switchSlot(slot.id, (step) => setBusy({ label: SWITCH_STEP_LABELS[step] }));
        const parts = [`已切换到『${result.targetName}』。`];
        if (result.archivedTo) parts.push(`切换前的数据已归档到『${result.archivedTo}』。`);
        setRestartNotice({ title: "档位已切换，请彻底重启应用", summary: parts.join("") });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "未知错误";
        onNotice(`切换未完成：${detail}。各档位快照仍然完好，可以重试。`);
      } finally {
        setBusy(null);
        await refresh();
      }
    })();
  };

  const switchConfirmMessage = (slot: SlotMeta): string => {
    if (!registry?.currentSlotId) {
      return `当前数据还没有归属档位：会先自动把它保存为一个存档，然后载入『${slot.name}』。切换完成后需要彻底重启应用。`;
    }
    if (!slot.hasData) {
      return `『${slot.name}』是空白档位：切换后是一个全新的默认状态（你现在的数据会先自动归档，不会丢）。切换完成后需要彻底重启应用。`;
    }
    return `切换到『${slot.name}』？当前档位会先自动归档保存，然后载入目标档位。切换完成后需要彻底重启应用。`;
  };

  return (
    <PageShell title="档位" onBack={busy || restartNotice ? undefined : onClose}>
      <div className="page-menu" style={{ padding: "12px 16px 32px", display: "flex", flexDirection: "column", gap: 14 }}>
        {registry === null ? (
          <div className="menu-group">
            <div className="menu-item" style={{ cursor: "default" }}>
              <Loader2 size={16} className="animate-spin" />
              <div className="menu-label-group">
                <span className="menu-label">读取中…</span>
              </div>
            </div>
          </div>
        ) : currentSlot ? (
          <div className="menu-group">
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "var(--c-icon-teal)" }}>
                <Archive size={16} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">当前档位：{currentSlot.name}</span>
                <span className="menu-desc">
                  {currentSlot.hasData
                    ? `${formatBytes(currentSlot.bytes)} · ${currentSlot.records} 条记录 · ${formatTime(currentSlot.lastUsedAt ?? currentSlot.updatedAt)}`
                    : "空白档位（暂无数据）"}
                </span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button type="button" className={SMALL_BUTTON_CLASS} disabled={Boolean(busy)} onClick={handleSaveProgress}>
                <Save size={14} /> 保存当前进度
              </button>
              <button type="button" className={SMALL_BUTTON_CLASS} disabled={Boolean(busy)} onClick={handleExport}>
                <Download size={14} /> 导出当前档位备份
              </button>
            </div>
          </div>
        ) : (
          <div className="menu-group">
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "var(--c-icon-amber)" }}>
                <Archive size={16} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">当前数据还没有归属档位</span>
                <span className="menu-desc">
                  先把它保存为一个档位，之后新建 / 切换档位才安全；也可以直接新建空白档位。
                </span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default", justifyContent: "flex-end" }}>
              <button type="button" className="ui-btn ui-btn-primary py-1 px-3 ts-12" disabled={Boolean(busy)} onClick={openSaveCurrent}>
                <Save size={14} /> 保存当前数据为档位
              </button>
            </div>
          </div>
        )}

        <div className="menu-group">
          <div className="menu-item" style={{ cursor: "default" }}>
            <div className="menu-label-group">
              <span className="menu-label" style={{ fontWeight: 600 }}>
                全部档位（{registry?.slots.length ?? 0}）
              </span>
            </div>
            <button type="button" className={SMALL_BUTTON_CLASS} disabled={Boolean(busy)} onClick={openCreateEmpty}>
              <Plus size={14} /> 新建空白档位
            </button>
          </div>
          {registry !== null && registry.slots.length === 0 && (
            <div className="menu-item" style={{ cursor: "default" }}>
              <span className="menu-desc">还没有档位。先把当前数据保存为档位，或新建一个空白档位。</span>
            </div>
          )}
          {registry?.slots.map((slot) => {
            const isCurrent = slot.id === registry.currentSlotId;
            return (
              <div className="menu-item" key={slot.id} style={{ cursor: "default", flexWrap: "wrap" }}>
                <div className="menu-icon" style={{ background: "var(--c-icon-lilac)" }}>
                  <Archive size={16} />
                </div>
                <div className="menu-label-group">
                  <span className="menu-label">
                    {slot.name}
                    {isCurrent ? "（当前）" : ""}
                  </span>
                  <span className="menu-desc">
                    创建于 {formatTime(slot.createdAt)} · {slot.hasData ? `${formatBytes(slot.bytes)} · ${slot.records} 条记录` : "空白档位"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {!isCurrent && (
                    <button type="button" className={SMALL_BUTTON_CLASS} disabled={Boolean(busy)} onClick={() => setDialog({ type: "switch", slot })}>
                      <ArrowRightLeft size={14} /> 切换
                    </button>
                  )}
                  <button type="button" className={SMALL_BUTTON_CLASS} disabled={Boolean(busy)} onClick={() => openRename(slot)}>
                    <Pencil size={14} /> 重命名
                  </button>
                  {!isCurrent && (
                    <button type="button" className={SMALL_DANGER_BUTTON_CLASS} disabled={Boolean(busy)} onClick={() => setDialog({ type: "delete", slot })}>
                      <Trash2 size={14} /> 删除
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="menu-group">
          <div className="menu-item" style={{ cursor: "default" }}>
            <div className="menu-label-group">
              <span className="menu-label">说明</span>
              <span className="menu-desc">
                每个档位是独立的一套数据：角色、聊天、记忆、设置互不影响。切换时当前档位会自动归档，切换完成后需要彻底重启应用。
                导出备份时，导出的就是当前档位的数据；导入备份仍在「设置 → 数据管理」里操作。
              </span>
            </div>
          </div>
        </div>
      </div>

      {dialog?.type === "create-empty" && (
        <ContentDialog title="新建空白档位" confirmLabel="创建" onCancel={closeDialog} onConfirm={handleCreateEmpty}>
          <p style={dialogDescStyle}>
            新档位是全新空白状态：没有角色、没有聊天记录、没有记忆，设置也是独立的。之后可以随时把数据填进去。
          </p>
          <Input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="档位名称" maxLength={30} autoFocus />
        </ContentDialog>
      )}

      {dialog?.type === "save-current" && (
        <ContentDialog title="保存当前数据为档位" confirmLabel="保存" onCancel={closeDialog} onConfirm={handleSaveCurrent}>
          <p style={dialogDescStyle}>
            把当前设备上的全部数据（角色、聊天、记忆、设置…）保存为一个新档位，并把它设为当前档位。
          </p>
          <Input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="档位名称" maxLength={30} autoFocus />
        </ContentDialog>
      )}

      {dialog?.type === "rename" && (
        <ContentDialog title="重命名档位" confirmLabel="保存" onCancel={closeDialog} onConfirm={() => handleRename(dialog.slot)}>
          <Input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="档位名称" maxLength={30} autoFocus />
        </ContentDialog>
      )}

      {dialog?.type === "delete" && (
        <ConfirmDialog
          title={`删除档位『${dialog.slot.name}』？`}
          message="该档位的数据快照将被永久删除，无法恢复。"
          icon={Trash2}
          variant="danger"
          confirmLabel="删除"
          onConfirm={() => handleDelete(dialog.slot)}
          onCancel={closeDialog}
        />
      )}

      {dialog?.type === "switch" && (
        <ConfirmDialog
          title={`切换到『${dialog.slot.name}』？`}
          message={switchConfirmMessage(dialog.slot)}
          icon={ArrowRightLeft}
          variant="action"
          confirmLabel="切换"
          onConfirm={() => handleSwitch(dialog.slot)}
          onCancel={closeDialog}
        />
      )}

      {busy && (
        <div className="modal-overlay" data-ui="modal">
          <div className="modal-dialog" data-ui="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body" data-ui="modal-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", padding: "22px 18px" }}>
              <Loader2 size={26} className="animate-spin" />
              <div style={{ fontWeight: 500 }}>{busy.label}</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>数据量大时可能需要一点时间，请不要离开本页面</div>
            </div>
          </div>
        </div>
      )}

      {/* 不给遮罩挂 onClick：这条必须让用户显式重启，误触关掉就等于没提示过。 */}
      {restartNotice && (
        <div className="modal-overlay" data-ui="modal">
          <div className="modal-dialog" data-ui="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header" data-ui="modal-header">
              <div className="ui-icon-circle">
                <RotateCcw size={20} />
              </div>
              <h3 className="modal-title">{restartNotice.title}</h3>
            </div>
            <div className="modal-body" data-ui="modal-body" style={{ textAlign: "left", width: "100%" }}>
              <p style={{ whiteSpace: "pre-line" }}>{buildRestartMessage(restartNotice.summary)}</p>
            </div>
            <div className="modal-footer" data-ui="modal-footer" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                style={{ width: "100%", whiteSpace: "nowrap" }}
                onClick={() => window.location.reload()}
              >
                <RotateCcw size={16} /> 立即重启
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}