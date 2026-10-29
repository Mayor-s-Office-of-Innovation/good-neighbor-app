import { afterEach, expect, it, vi } from "vitest";
import { readCaptureFiles } from "./capture-files.js";

afterEach(() => vi.unstubAllGlobals());
function readerStub() {
  const pending = [];
  vi.stubGlobal(
    "FileReader",
    class {
      onload = () => {};
      readAsDataURL(file) {
        pending.push(() => {
          this.result = `data:${file.name}`;
          this.onload();
        });
      }
    },
  );
  return pending;
}
it("reads every selection in order", async () => {
  const pending = readerStub();
  const onPhoto = vi.fn();
  const reading = readCaptureFiles(
    [new File([], "first"), new File([], "second")],
    () => true,
    onPhoto,
  );
  pending.shift()();
  await Promise.resolve();
  expect(onPhoto).toHaveBeenCalledWith("data:first");
  pending.shift()();
  await reading;
  expect(onPhoto.mock.calls).toEqual([["data:first"], ["data:second"]]);
});
it("discards the in-flight photo and remaining batch after leaving the session", async () => {
  const pending = readerStub();
  let current = true;
  const onPhoto = vi.fn();
  const reading = readCaptureFiles(
    [new File([], "first"), new File([], "second")],
    () => current,
    onPhoto,
  );
  current = false;
  pending.shift()();
  await reading;
  expect(onPhoto).not.toHaveBeenCalled();
  expect(pending).toHaveLength(0);
});
