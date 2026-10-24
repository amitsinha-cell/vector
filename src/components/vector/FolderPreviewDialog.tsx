import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, FileCode, Folder, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FolderFilterResult } from "@/lib/folderFilter";

interface FolderPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filterResult: FolderFilterResult | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function FolderPreviewDialog({
  open,
  onOpenChange,
  filterResult,
  onConfirm,
  onCancel,
}: FolderPreviewDialogProps) {
  const [showSkippedDetails, setShowSkippedDetails] = useState(false);

  if (!filterResult) return null;

  const totalRaw = filterResult.included.length + filterResult.skipped.length;
  const sizeKb = Math.round(filterResult.totalBytes / 1024);
  const sizeMb = (filterResult.totalBytes / (1024 * 1024)).toFixed(2);
  const formattedSize = filterResult.totalBytes > 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;

  const sortedLanguages = Object.entries(filterResult.languageCounts).sort((a, b) => b[1] - a[1]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-lg max-h-[85vh] flex flex-col p-5">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary">
            <div className="rounded-xl bg-primary/10 p-2">
              <Folder className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">
                Upload Folder: {filterResult.folderName}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Review files before sending to Vector for summarisation
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
          {/* Trimming warning if any */}
          {filterResult.trimmedReason && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
              <div>
                <p className="font-semibold">Limits Exceeded</p>
                <p className="mt-0.5">{filterResult.trimmedReason}</p>
              </div>
            </div>
          )}

          {/* Counts overview stats */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-xl border bg-card p-3 shadow-sm">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Included Files
              </p>
              <p className="text-lg font-bold text-foreground mt-0.5">
                {filterResult.included.length}{" "}
                <span className="text-xs font-normal text-muted-foreground">({formattedSize})</span>
              </p>
            </div>
            <div className="rounded-xl border bg-card p-3 shadow-sm">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Skipped Files
              </p>
              <p className="text-lg font-bold text-muted-foreground mt-0.5">
                {filterResult.skipped.length}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  of {totalRaw} total
                </span>
              </p>
            </div>
          </div>

          {/* Languages breakdown */}
          {sortedLanguages.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Languages & Technologies
              </p>
              <div className="flex flex-wrap gap-1.5">
                {sortedLanguages.map(([lang, count]) => (
                  <span
                    key={lang}
                    className="inline-flex items-center gap-1 rounded-lg border bg-accent/50 px-2 py-1 text-xs font-medium"
                  >
                    <span>{lang}</span>
                    <span className="rounded bg-background/80 px-1.5 py-0.2 text-[10px] font-mono text-muted-foreground">
                      {count}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Skipped files breakdown */}
          {filterResult.skipped.length > 0 && (
            <div className="rounded-xl border bg-muted/30 p-3 space-y-2 text-xs">
              <button
                type="button"
                onClick={() => setShowSkippedDetails((v) => !v)}
                className="flex w-full items-center justify-between font-medium text-muted-foreground hover:text-foreground"
              >
                <span>Skipped breakdown ({filterResult.skipped.length} files)</span>
                {showSkippedDetails ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>

              {showSkippedDetails && (
                <div className="space-y-1.5 pt-1 border-t">
                  {Object.entries(filterResult.skippedByReason).map(([reason, count]) => (
                    <div
                      key={reason}
                      className="flex items-center justify-between text-muted-foreground text-[11px]"
                    >
                      <span className="truncate pr-2">{reason}</span>
                      <span className="font-mono shrink-0 font-medium">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mt-3 flex sm:justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={filterResult.included.length === 0}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            Confirm Upload ({filterResult.included.length} files)
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
