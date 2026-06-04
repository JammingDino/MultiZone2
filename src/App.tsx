import { Sidebar } from "./components/Sidebar/Sidebar";
import { ChatPanel } from "./components/Chat/ChatPanel";

export default function App() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <Sidebar />
      <ChatPanel />
    </div>
  );
}
