import { createPinia, setActivePinia } from "pinia";

import { useAppStore } from "./app";

describe("app store file tabs", () => {
  it("deduplicates tabs, chooses a neighbor on close, and resets across workspaces", () => {
    setActivePinia(createPinia());
    const store = useAppStore();

    store.setFileWorkspace("C:/one");
    store.openFile("src/a.ts");
    store.openFile("src/b.ts");
    store.openFile("src/a.ts");
    expect(store.fileTabs).toHaveLength(2);
    expect(store.activeFilePath).toBe("src/a.ts");

    store.closeFile("src/a.ts");
    expect(store.activeFilePath).toBe("src/b.ts");

    store.setFileWorkspace("C:/two");
    expect(store.fileTabs).toEqual([]);
    expect(store.activeFilePath).toBeNull();
  });
});
