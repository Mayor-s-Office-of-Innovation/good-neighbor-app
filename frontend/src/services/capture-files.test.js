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

import {
  CaptureFileQueue,
  CAPTURE_MAX_FILE_BYTES,
  CAPTURE_MAX_BYTES,
} from "./capture-files.js";

it("reserves queued selections against existing evidence and releases cancelled reads", async () => {
  const readers = readerStub();
  const queue = new CaptureFileQueue();
  const items = Array.from({ length: 18 }, () => ({ kind: "text" }));
  let current = true;
  const photo = vi.fn();
  const change = vi.fn();
  const pick = () =>
    queue.enqueue(
      [new File([], "one"), new File([], "two")],
      items,
      () => current,
      photo,
      change,
    );
  expect(pick()).toBe(0);
  expect(queue.busy).toBe(true);
  expect(pick()).toBe(2);
  await Promise.resolve();
  current = false;
  readers.shift()();
  await queue.tail;
  expect(queue.busy).toBe(false);
  expect(photo).not.toHaveBeenCalled();
  expect(readers).toHaveLength(0);
});

it("rejects oversized files before reading and counts existing and queued bytes", async () => {
  const readers = readerStub();
  const queue = new CaptureFileQueue();
  const items = [{ upload: { contentLength: CAPTURE_MAX_BYTES - 4 } }];
  const file = new File(["1234"], "fits");
  const oversized = new File([], "large");
  Object.defineProperty(oversized, "size", {
    value: CAPTURE_MAX_FILE_BYTES + 1,
  });
  const photo = vi.fn();
  expect(
    queue.enqueue(
      [oversized, file],
      items,
      () => true,
      photo,
      () => {},
    ),
  ).toBe(1);
  expect(
    queue.enqueue(
      [file],
      items,
      () => true,
      photo,
      () => {},
    ),
  ).toBe(1);
  await Promise.resolve();
  expect(readers).toHaveLength(1);
  readers.shift()();
  await queue.tail;
  expect(photo).toHaveBeenCalledTimes(1);
  expect(queue.busy).toBe(false);
});

it("accounts for restored data URLs including base64 padding", () => {
  const queue = new CaptureFileQueue();
  const items = [
    { dataUrl: "data:image/png;base64,YQ==" },
    { upload: { contentLength: CAPTURE_MAX_BYTES - 1 } },
  ];
  expect(
    queue.enqueue(
      [new File(["a"], "over")],
      items,
      () => true,
      vi.fn(),
      vi.fn(),
    ),
  ).toBe(1);
  expect(queue.busy).toBe(false);
});

it("settles failed readers and allows the next selection", async () => {
  vi.stubGlobal(
    "FileReader",
    class {
      readAsDataURL() {
        throw new Error("read failed");
      }
    },
  );
  const queue = new CaptureFileQueue();
  const photo = vi.fn();
  queue.enqueue([new File([], "failed")], [], () => true, photo, vi.fn());
  await queue.tail;
  expect(queue.busy).toBe(false);
  const readers = readerStub();
  queue.enqueue([new File([], "retry")], [], () => true, photo, vi.fn());
  await Promise.resolve();
  readers.shift()();
  await queue.tail;
  expect(photo).toHaveBeenCalledWith("data:retry");
});

it("binary capture awaits durable admission and reserves bytes while saving", async () => {
  const queue = new CaptureFileQueue(true);
  vi.stubGlobal(
    "FileReader",
    class {
      constructor() {
        throw new Error("No base64 on binary captures");
      }
    },
  );
  const file = new File(["original"], "synthetic.jpg", { type: "image/jpeg" });
  /** @type {() => void} */
  let finish = () => {};
  const save = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(undefined);
      }),
  );
  queue.enqueue(
    [file],
    [],
    () => true,
    save,
    () => {},
  );
  await Promise.resolve();
  expect(queue.busy).toBe(true);
  expect(save).toHaveBeenCalledWith(file);
  finish?.();
  await queue.tail;
  expect(queue.busy).toBe(false);
});
