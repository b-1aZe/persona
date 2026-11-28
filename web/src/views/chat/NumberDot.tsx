import { cx } from "../../ui/atoms";

/** The round number a comment carries, in the popover and next to its words in the transcript. */
export function NumberDot({ n, className }: { n: number; className?: string }) {
  return (
    <span aria-hidden className={cx("flex size-4 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] leading-none font-semibold text-white tabular-nums", className)}>
      {n}
    </span>
  );
}
