import { beforeEach, expect, it, vi } from "vitest";
import { currentManagerOversight } from "./site-manager-name.js";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "test");
});
it("resolves renamed managers across directory pages without changing the stored snapshot", async () => {
  const oversight = {
    cityProgramManagerId: "id",
    cityProgramManager: "Old Name",
    managingCityDepartment: "DPH",
  };
  send.mockResolvedValueOnce({
    Items: [],
    LastEvaluatedKey: { pk: "directory", sk: "page" },
  });
  send.mockResolvedValueOnce({
    Items: [{ userId: "id", firstName: "New", lastName: "Name" }],
  });
  expect(await currentManagerOversight(oversight)).toEqual({
    ...oversight,
    cityProgramManager: "New Name",
  });
  expect(oversight.cityProgramManager).toBe("Old Name");
  expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
    pk: "directory",
    sk: "page",
  });
  expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
});
it("preserves legacy and missing-directory snapshots", async () => {
  const legacy = { cityProgramManager: "Legacy" };
  expect(await currentManagerOversight(legacy)).toEqual(legacy);
  expect(send).not.toHaveBeenCalled();
  send.mockResolvedValue({ Items: [] });
  const missing = { ...legacy, cityProgramManagerId: "missing" };
  expect(await currentManagerOversight(missing)).toEqual(missing);
});
