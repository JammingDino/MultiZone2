import {
  Wrench,
  FilePen,
  FileText,
  Folder,
  Search,
  TerminalSquare,
  Globe,
  ArrowLeftRight,
  Bot,
  Users,
  Brain,
  BookOpen,
  Settings2,
  Sparkles,
} from "lucide-react";
import { familyOf } from "./families";

/**
 * The glyph for a tool step (0.13.3).
 *
 * Every step used to carry the same wrench, which made a collapsed run of
 * twenty steps a column of identical marks — the one place a glyph could have
 * done real work, since the strip is usually read collapsed. The icon comes
 * from the family, so it stays in step with the visual the step expands into
 * and a new tool inherits one by being mapped.
 */
const ICONS = {
  diff: FilePen,
  file: FileText,
  tree: Folder,
  match: Search,
  terminal: TerminalSquare,
  web: Globe,
  page: Globe,
  http: ArrowLeftRight,
  agent: Bot,
  board: Users,
  memory: Brain,
  skill: BookOpen,
  state: Settings2,
  existing: Sparkles,
} as const;

export function familyIcon(name: string) {
  const family = familyOf(name);
  return family ? ICONS[family] : Wrench;
}
