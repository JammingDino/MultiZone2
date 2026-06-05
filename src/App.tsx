import { Sidebar } from "./components/Sidebar/Sidebar";
import { ChatPanel } from "./components/Chat/ChatPanel";
import { BackgroundEffect } from "./components/BackgroundEffect";
import { TitleBar } from "./components/TitleBar";

export default function App() {
  return (
    <div className="h-screen w-screen overflow-hidden text-[var(--color-text)]">
      <BackgroundEffect />
      <div className="relative z-10 flex h-full w-full flex-col">
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
