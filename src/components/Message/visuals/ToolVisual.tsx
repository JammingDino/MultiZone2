import { familyOf } from "./families";
import { Shaped } from "./Shaped";
import { EditVisual } from "./EditVisual";
import { TerminalVisual } from "./TerminalVisual";
import { FileVisual } from "./FileVisual";
import { TreeVisual } from "./TreeVisual";
import { MatchVisual } from "./MatchVisual";

/**
 * The family dispatch, shared by the step card and the replay (0.13.1).
 *
 * It lives here rather than inside `StepBlock` because replay is the other
 * place a tool call is read, and it is read there precisely when something went
 * wrong — a replay that showed a worse view of the same call than the
 * transcript did would be the wrong way round.
 *
 * A tool with no family — every MCP tool, and any built-in whose family isn't
 * built yet — falls to the shaped fallback. Nothing renders as raw JSON by
 * default.
 */
export function ToolVisual({
  name,
  args,
  parsed,
  isError,
}: {
  name: string;
  args: any;
  parsed: any;
  isError: boolean;
}): React.ReactElement | null {
  // An error is its own visual, in whatever words it arrived in. The Output tab
  // holds the unedited text and a card repeating it adds nothing.
  if (isError || parsed === null || parsed === undefined) return null;

  const record = asRecord(parsed);

  switch (familyOf(name)) {
    case "diff":
      return <EditVisual name={name} args={args} result={record} />;
    case "terminal":
      return record ? <TerminalVisual name={name} args={args} result={record} /> : null;
    case "file":
      return record ? <FileVisual name={name} args={args} result={record} /> : null;
    case "tree":
      return record ? <TreeVisual name={name} args={args} result={record} /> : null;
    case "match":
      return record ? <MatchVisual name={name} args={args} result={record} /> : null;
    case "existing":
      // Rendered by `renderToolOutput` above the tabs, or carrying no result
      // worth shaping (`ask_user`).
      return null;
    default:
      return <Shaped value={parsed} />;
  }
}

/** Whether a tool's result gets a visual at all, without rendering one. */
export function hasToolVisual(name: string, parsed: any, isError: boolean): boolean {
  if (isError || parsed === null || parsed === undefined) return false;
  return familyOf(name) !== "existing";
}

function asRecord(v: any): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
