import { AlertCircle, RefreshCw, Trash2 } from "lucide-react";

interface UnreadableSummaryCardProps {
  title?: string | undefined;
  onResummarise?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}

export function UnreadableSummaryCard({
  title,
  onResummarise,
  onDelete,
}: UnreadableSummaryCardProps) {
  return (
    <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 shadow-sm space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
          <AlertCircle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            {title
              ? `Unreadable summary: ${title}`
              : "This summary is in an old or unreadable format"}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            The saved data cannot be parsed into a supported summary format. You can re-summarise
            the source or remove this item from your history.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-destructive/10">
        {onResummarise && (
          <button
            onClick={onResummarise}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Re-summarise
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-background px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete summary
          </button>
        )}
      </div>
    </div>
  );
}
