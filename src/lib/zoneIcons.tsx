import {
  // AI & Technology
  Brain, Bot, Cpu, Code, Terminal, Database, Server, Cloud, Globe, Wifi,
  Zap, Lightbulb, Microscope, FlaskConical, Atom, Satellite, CircuitBoard,
  Radio, Antenna, BrainCircuit,
  // Analysis & Data
  BarChart2, LineChart, PieChart, TrendingUp, TrendingDown, Search,
  Calculator, Scale, Gauge, Target, Filter, Hash, ScanSearch, Activity,
  // Creative & Writing
  Pen, Paintbrush, Palette, Camera, Music, Film, BookOpen, FileText, Feather,
  Sparkles, Star, Diamond, Gem, Edit, Newspaper, ScrollText,
  // Communication
  MessageSquare, MessageCircle, Mail, Phone, Video, Mic, Headphones, Bell, Send, Link2,
  // Science & Nature
  Sun, Moon, Mountain, Waves, Flame, Wind, Leaf, Eye, Dna, TestTube,
  // Protection & Security
  Shield, Lock, Key, Fingerprint, ShieldCheck, ScanFace,
  // Work & Industry
  Briefcase, Building2, Hammer, Wrench, Cog, Package, Box, GitBranch, Network, Factory,
  // Navigation & Focus
  Compass, Map, Navigation, Crosshair, Telescope, Focus, Radar,
  // People & Society
  User, Users, Crown, Award, Trophy, Bookmark, Flag, Heart,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ZoneIconDef {
  id: string;
  icon: LucideIcon;
  label: string;
}

export const ZONE_ICON_GROUPS: { label: string; icons: ZoneIconDef[] }[] = [
  {
    label: "AI & Technology",
    icons: [
      { id: "Brain", icon: Brain, label: "Brain" },
      { id: "BrainCircuit", icon: BrainCircuit, label: "Brain Circuit" },
      { id: "Bot", icon: Bot, label: "Bot" },
      { id: "Cpu", icon: Cpu, label: "CPU" },
      { id: "Code", icon: Code, label: "Code" },
      { id: "Terminal", icon: Terminal, label: "Terminal" },
      { id: "Database", icon: Database, label: "Database" },
      { id: "Server", icon: Server, label: "Server" },
      { id: "Cloud", icon: Cloud, label: "Cloud" },
      { id: "Globe", icon: Globe, label: "Globe" },
      { id: "Wifi", icon: Wifi, label: "Wifi" },
      { id: "Zap", icon: Zap, label: "Zap" },
      { id: "Lightbulb", icon: Lightbulb, label: "Lightbulb" },
      { id: "Microscope", icon: Microscope, label: "Microscope" },
      { id: "FlaskConical", icon: FlaskConical, label: "Flask" },
      { id: "Atom", icon: Atom, label: "Atom" },
      { id: "Satellite", icon: Satellite, label: "Satellite" },
      { id: "CircuitBoard", icon: CircuitBoard, label: "Circuit Board" },
      { id: "Radio", icon: Radio, label: "Radio" },
      { id: "Antenna", icon: Antenna, label: "Antenna" },
    ],
  },
  {
    label: "Analysis & Data",
    icons: [
      { id: "BarChart2", icon: BarChart2, label: "Bar Chart" },
      { id: "LineChart", icon: LineChart, label: "Line Chart" },
      { id: "PieChart", icon: PieChart, label: "Pie Chart" },
      { id: "TrendingUp", icon: TrendingUp, label: "Trending Up" },
      { id: "TrendingDown", icon: TrendingDown, label: "Trending Down" },
      { id: "Activity", icon: Activity, label: "Activity" },
      { id: "Search", icon: Search, label: "Search" },
      { id: "ScanSearch", icon: ScanSearch, label: "Scan Search" },
      { id: "Calculator", icon: Calculator, label: "Calculator" },
      { id: "Scale", icon: Scale, label: "Scale" },
      { id: "Gauge", icon: Gauge, label: "Gauge" },
      { id: "Target", icon: Target, label: "Target" },
      { id: "Filter", icon: Filter, label: "Filter" },
      { id: "Hash", icon: Hash, label: "Hash" },
    ],
  },
  {
    label: "Creative & Writing",
    icons: [
      { id: "Pen", icon: Pen, label: "Pen" },
      { id: "Edit", icon: Edit, label: "Edit" },
      { id: "Paintbrush", icon: Paintbrush, label: "Paintbrush" },
      { id: "Palette", icon: Palette, label: "Palette" },
      { id: "Camera", icon: Camera, label: "Camera" },
      { id: "Music", icon: Music, label: "Music" },
      { id: "Film", icon: Film, label: "Film" },
      { id: "BookOpen", icon: BookOpen, label: "Book Open" },
      { id: "FileText", icon: FileText, label: "File Text" },
      { id: "Newspaper", icon: Newspaper, label: "Newspaper" },
      { id: "ScrollText", icon: ScrollText, label: "Scroll" },
      { id: "Feather", icon: Feather, label: "Feather" },
      { id: "Sparkles", icon: Sparkles, label: "Sparkles" },
      { id: "Star", icon: Star, label: "Star" },
      { id: "Diamond", icon: Diamond, label: "Diamond" },
      { id: "Gem", icon: Gem, label: "Gem" },
    ],
  },
  {
    label: "Communication",
    icons: [
      { id: "MessageSquare", icon: MessageSquare, label: "Message Square" },
      { id: "MessageCircle", icon: MessageCircle, label: "Message Circle" },
      { id: "Mail", icon: Mail, label: "Mail" },
      { id: "Phone", icon: Phone, label: "Phone" },
      { id: "Video", icon: Video, label: "Video" },
      { id: "Mic", icon: Mic, label: "Mic" },
      { id: "Headphones", icon: Headphones, label: "Headphones" },
      { id: "Bell", icon: Bell, label: "Bell" },
      { id: "Send", icon: Send, label: "Send" },
      { id: "Link2", icon: Link2, label: "Link" },
    ],
  },
  {
    label: "Science & Nature",
    icons: [
      { id: "Dna", icon: Dna, label: "DNA" },
      { id: "TestTube", icon: TestTube, label: "Test Tube" },
      { id: "Sun", icon: Sun, label: "Sun" },
      { id: "Moon", icon: Moon, label: "Moon" },
      { id: "Mountain", icon: Mountain, label: "Mountain" },
      { id: "Waves", icon: Waves, label: "Waves" },
      { id: "Flame", icon: Flame, label: "Flame" },
      { id: "Wind", icon: Wind, label: "Wind" },
      { id: "Leaf", icon: Leaf, label: "Leaf" },
      { id: "Eye", icon: Eye, label: "Eye" },
    ],
  },
  {
    label: "Security",
    icons: [
      { id: "Shield", icon: Shield, label: "Shield" },
      { id: "ShieldCheck", icon: ShieldCheck, label: "Shield Check" },
      { id: "Lock", icon: Lock, label: "Lock" },
      { id: "Key", icon: Key, label: "Key" },
      { id: "Fingerprint", icon: Fingerprint, label: "Fingerprint" },
      { id: "ScanFace", icon: ScanFace, label: "Face Scan" },
    ],
  },
  {
    label: "Work & Industry",
    icons: [
      { id: "Briefcase", icon: Briefcase, label: "Briefcase" },
      { id: "Building2", icon: Building2, label: "Building" },
      { id: "Factory", icon: Factory, label: "Factory" },
      { id: "Hammer", icon: Hammer, label: "Hammer" },
      { id: "Wrench", icon: Wrench, label: "Wrench" },
      { id: "Cog", icon: Cog, label: "Cog" },
      { id: "Package", icon: Package, label: "Package" },
      { id: "Box", icon: Box, label: "Box" },
      { id: "GitBranch", icon: GitBranch, label: "Git Branch" },
      { id: "Network", icon: Network, label: "Network" },
    ],
  },
  {
    label: "People & Navigation",
    icons: [
      { id: "User", icon: User, label: "User" },
      { id: "Users", icon: Users, label: "Users" },
      { id: "Crown", icon: Crown, label: "Crown" },
      { id: "Award", icon: Award, label: "Award" },
      { id: "Trophy", icon: Trophy, label: "Trophy" },
      { id: "Heart", icon: Heart, label: "Heart" },
      { id: "Bookmark", icon: Bookmark, label: "Bookmark" },
      { id: "Flag", icon: Flag, label: "Flag" },
      { id: "Compass", icon: Compass, label: "Compass" },
      { id: "Map", icon: Map, label: "Map" },
      { id: "Navigation", icon: Navigation, label: "Navigation" },
      { id: "Crosshair", icon: Crosshair, label: "Crosshair" },
      { id: "Telescope", icon: Telescope, label: "Telescope" },
      { id: "Focus", icon: Focus, label: "Focus" },
      { id: "Radar", icon: Radar, label: "Radar" },
    ],
  },
];

export const ZONE_ICONS: ZoneIconDef[] = ZONE_ICON_GROUPS.flatMap((g) => g.icons);

const iconMap: Record<string, LucideIcon> = Object.fromEntries(
  ZONE_ICONS.map(({ id, icon }) => [id, icon]),
);

/** Returns the Lucide component for a stored icon id, or Bot as fallback. */
export function getZoneIcon(iconId: string | null | undefined): LucideIcon {
  if (!iconId) return Bot;
  return iconMap[iconId] ?? Bot;
}

export const ZONE_COLOR_PRESETS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#84cc16", // lime
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f43f5e", // rose
];
