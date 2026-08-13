import { flushPromises, mount } from "@vue/test-utils";
import { vi } from "vitest";

import { listFiles } from "@/lib/api";
import FileExplorer from "@/components/FileExplorer.vue";

vi.mock("@/lib/api", () => ({
  listFiles: vi.fn(),
}));

const mockedListFiles = vi.mocked(listFiles);

describe("FileExplorer", () => {
  it("loads the root lazily and emits nested file paths", async () => {
    mockedListFiles
      .mockResolvedValueOnce({
        path: "C:/work",
        entries: [{ name: "src", isDir: true, size: 0, modified: "2026-01-01" }],
      })
      .mockResolvedValueOnce({
        path: "C:/work/src",
        entries: [{ name: "main.ts", isDir: false, size: 12, modified: "2026-01-01" }],
      });

    const wrapper = mount(FileExplorer, { props: { root: "C:/work" } });
    await flushPromises();
    await wrapper.find(".file-tree-row").trigger("click");
    await flushPromises();
    await wrapper.findAll(".file-tree-row")[1].trigger("click");

    expect(mockedListFiles).toHaveBeenNthCalledWith(1, "C:/work");
    expect(mockedListFiles).toHaveBeenNthCalledWith(2, "C:/work", "src");
    expect(wrapper.emitted("open")).toEqual([["src/main.ts"]]);
  });
});
