/**
 * Which visual family a tool belongs to (0.13.0).
 *
 * `renderToolOutput` used to be an if-chain covering five tools out of
 * fifty-two; everything else fell through to a wall of escaped JSON. Families
 * are the fix: a tool joins one by adding a line here, and a tool in no family
 * still gets the shaped fallback rather than raw JSON.
 *
 * The map is deliberately exhaustive over the built-in tools even where the
 * family isn't implemented yet — an unimplemented family degrades to the same
 * shaped fallback, and having the intended grouping written down is what stops
 * the next tool being added without one. See docs/TOOL_VISUALS.md.
 */

export type Family =
  | "diff"
  | "file"
  | "tree"
  | "match"
  | "terminal"
  | "web"
  | "page"
  | "http"
  | "agent"
  | "board"
  | "memory"
  | "skill"
  | "state"
  | "existing";

export const FAMILY: Record<string, Family> = {
  // 1 · diff
  create_file: "diff",
  edit_file: "diff",
  // 2 · file card
  read_file: "file",
  present_file: "existing",
  create_folder: "file",
  move_file: "file",
  copy_file: "file",
  delete_file: "file",
  // 3 · tree
  list_directory: "tree",
  find_files: "tree",
  // 4 · match list
  search_file_text: "match",
  search_local_files: "match",
  // 5 · terminal
  run_command: "terminal",
  execute_code: "terminal",
  wsl_exec: "terminal",
  terminal_start: "terminal",
  terminal_write: "terminal",
  terminal_read: "terminal",
  terminal_stop: "terminal",
  terminal_list: "terminal",
  // 6 · web results
  smart_search: "web",
  // 7 · page
  smart_fetch: "page",
  smart_crawl: "page",
  // 8 · http
  http_request: "http",
  // 9 · agent
  spawn_subagent: "agent",
  send_subchat_message: "agent",
  collect_subagents: "agent",
  list_subchats: "agent",
  read_subchat: "agent",
  // 10 · team board
  claim_files: "board",
  release_files: "board",
  post_note: "board",
  team_status: "board",
  // 11 · memory
  save_memory: "memory",
  read_memory: "memory",
  delete_memory: "memory",
  // 12 · skill
  load_skill: "skill",
  create_skill: "skill",
  update_skill: "skill",
  // 13 · state change
  change_zone: "state",
  list_zones: "state",
  tag_chat: "state",
  app_control: "state",
  app_read: "state",
  compact_context: "state",
  get_current_datetime: "state",
  enter_plan_mode: "state",
  // 14 · the renderers that already existed
  plot_function: "existing",
  render_chart: "existing",
  draw_diagram: "existing",
  update_plan: "existing",
  exit_plan_mode: "existing",
  ask_user: "existing",
};

export function familyOf(name: string): Family | null {
  return FAMILY[name] ?? null;
}
