import { familyOf } from "./families";
import { Shaped } from "./Shaped";
import { EditVisual } from "./EditVisual";
import { TerminalVisual } from "./TerminalVisual";
import { FileVisual } from "./FileVisual";
import { TreeVisual } from "./TreeVisual";
import { MatchVisual } from "./MatchVisual";
import { AgentVisual } from "./AgentVisual";
import { BoardVisual, ClaimRefusal } from "./BoardVisual";
import { WebVisual } from "./WebVisual";
import { HttpVisual } from "./HttpVisual";
import { MemoryVisual, SkillVisual, ChangeVisual } from "./StateVisual";

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
  if (parsed === null || parsed === undefined) return null;

  const record = asRecord(parsed);

  if (isError) {
    // Most errors are their own visual already: the Output tab holds the
    // unedited text and a card repeating it adds nothing. The exception is a
    // failure the backend gave *structure* to — a write refused because another
    // agent holds the file is the moment the teamwork layer exists for, and it
    // was reaching the reader as a red string.
    if (record?.error_kind === "claimed") {
      return (
        <ClaimRefusal
          message={String(record.error ?? "")}
          next={typeof record.next === "string" ? record.next : undefined}
        />
      );
    }
    return null;
  }

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
    case "agent":
      return record ? <AgentVisual name={name} args={args} result={record} /> : null;
    case "board":
      return record ? <BoardVisual name={name} args={args} result={record} /> : null;
    case "web":
    case "page":
      return record ? <WebVisual name={name} args={args} result={record} /> : null;
    case "http":
      return record ? <HttpVisual name={name} args={args} result={record} /> : null;
    case "memory":
      return record ? <MemoryVisual name={name} args={args} result={record} /> : null;
    case "skill":
      return record ? <SkillVisual name={name} args={args} result={record} /> : null;
    case "state":
      return record ? <ChangeVisual name={name} args={args} result={record} /> : null;
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
  if (parsed === null || parsed === undefined) return false;
  if (isError) return asRecord(parsed)?.error_kind === "claimed";
  return familyOf(name) !== "existing";
}

function asRecord(v: any): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
