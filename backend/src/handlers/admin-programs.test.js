import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  assignProgramToProvider,
  createProgram,
  createProgramUser,
  deactivateProgramUser,
  deactivateProgram,
  getProgram,
  listPrograms,
  updateProgram,
  updateProgramUser,
} = await import("./admin-programs.js");

const { assignSiteUser } = await import("./admin-site-config.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-verifier-secret");
});

describe("program administration", () => {
  it("lists active program search rows", async () => {
    send.mockResolvedValueOnce({ Items: [{ programId: "p-1" }] });
    const response = await call(listPrograms, event());
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
  });

  it("paginates the complete active program list", async () => {
    const cursor = { pk: "PROGRAM_SEARCH#ACTIVE", sk: "middle#p-1" };
    send
      .mockResolvedValueOnce({
        Items: [{ programId: "p-1" }],
        LastEvaluatedKey: cursor,
      })
      .mockResolvedValueOnce({ Items: [{ programId: "p-2" }] });

    const response = await call(listPrograms, event());

    expect(JSON.parse(String(response.body)).programs).toEqual([
      { programId: "p-1" },
      { programId: "p-2" },
    ]);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(cursor);
  });

  it("creates a program and both relationship projections atomically", async () => {
    send
      .mockResolvedValueOnce({
        Item: { providerId: "provider-1", name: "Provider", status: "active" },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      createProgram,
      event({ name: "Program One", providerId: "provider-1" }),
    );
    expect(response.statusCode).toBe(201);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems[0].Put.Item).toMatchObject({
      pk: "PROGRAM#provider-1-program-one",
      providerId: "provider-1",
    });
  });

  it("creates assignable first staff and defaults program contact in the same transaction", async () => {
    send
      .mockResolvedValueOnce({
        Item: { providerId: "provider-1", name: "Provider", status: "active" },
      })
      .mockResolvedValueOnce({});
    const firstStaff = {
      firstName: " Sam ",
      lastName: "Lee",
      phone: "4155550100",
      email: "SAM@example.org",
    };
    const response = await call(
      createProgram,
      event({ name: "Program One", providerId: "provider-1", firstStaff }),
    );
    expect(response.statusCode).toBe(201);
    const { program, user } = JSON.parse(String(response.body));
    expect(program.contact).toEqual({
      firstName: "Sam",
      lastName: "Lee",
      phone: "4155550100",
      phoneExtension: "",
      email: "sam@example.org",
    });
    expect(user).toMatchObject({
      pk: `PROGRAM#${program.programId}`,
      sk: `USER#${user.userId}`,
      type: "programUser",
      entityType: "PROGRAM_USER",
      programId: program.programId,
      ...program.contact,
      status: "active",
      siteAssignmentCount: 0,
      siteManager: false,
    });
    expect(user.userId).toBeTruthy();
    /** @type {any[]} */
    const items = send.mock.calls[1][0].input.TransactItems;
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.Put.Item)).toEqual(
      expect.arrayContaining([program, user]),
    );
    expect(
      items.every((item) =>
        item.Put.ConditionExpression.includes("attribute_not_exists"),
      ),
    ).toBe(true);
    send
      .mockResolvedValueOnce({ Item: program })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [user] });
    const loaded = await call(
      getProgram,
      event(undefined, { programId: program.programId }),
    );
    expect(JSON.parse(String(loaded.body)).users).toEqual([user]);
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          leadProgramId: program.programId,
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Item: user })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const assigned = await call(
      assignSiteUser,
      event({ userId: user.userId }, { siteId: "site-1" }),
    );
    expect(assigned.statusCode).toBe(201);
    expect(JSON.parse(String(assigned.body)).assignment).toMatchObject({
      userId: user.userId,
      programId: program.programId,
      siteId: "site-1",
      firstName: "Sam",
      lastName: "Lee",
    });
  });

  it("allows first staff without a phone", async () => {
    send
      .mockResolvedValueOnce({ Item: { name: "Provider", status: "active" } })
      .mockResolvedValueOnce({});
    const response = await call(
      createProgram,
      event({
        name: "New",
        providerId: "provider-1",
        firstStaff: {
          firstName: "Sam",
          lastName: "Lee",
          email: "sam@example.org",
        },
      }),
    );
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(String(response.body)).user.phone).toBe("");
  });

  it.each(["provider", "program"])(
    "adds %s staff without changing their original affiliation",
    async (kind) => {
      send.mockResolvedValueOnce({
        Item: { name: "Provider", status: "active" },
      });
      if (kind === "program")
        send.mockResolvedValueOnce({
          Item: { providerId: "provider-1", status: "active" },
        });
      send
        .mockResolvedValueOnce({
          Item: {
            firstName: "Sam",
            lastName: "Lee",
            email: "sam@example.org",
            status: "active",
            updatedAt: "version",
          },
        })
        .mockResolvedValueOnce({});
      const existingStaff =
        kind === "provider"
          ? { providerManagerId: "staff-1" }
          : { programId: "old", userId: "staff-1" };
      const response = await call(
        createProgram,
        event({ name: "New", providerId: "provider-1", existingStaff }),
      );
      expect(response.statusCode).toBe(201);
      const user = JSON.parse(String(response.body)).user;
      expect(user.staffSource).toMatchObject(existingStaff);
      expect(user.email).toBe("sam@example.org");
      /** @type {any[]} */
      const items =
        send.mock.calls[send.mock.calls.length - 1][0].input.TransactItems;
      expect(items.filter((item) => item.ConditionCheck).length).toBe(
        kind === "program" ? 2 : 1,
      );
      expect(items.every((item) => !item.Delete && !item.Update)).toBe(true);
      expect(
        items
          .filter((item) => item.Put)
          .every((item) => item.Put.Item.pk !== "PROGRAM#old"),
      ).toBe(true);
    },
  );

  it("rejects staff from another provider", async () => {
    send
      .mockResolvedValueOnce({ Item: { status: "active" } })
      .mockResolvedValueOnce({
        Item: { providerId: "other", status: "active" },
      });
    const response = await call(
      createProgram,
      event({
        name: "New",
        providerId: "provider-1",
        existingStaff: { programId: "other-program", userId: "staff" },
      }),
    );
    expect(response.statusCode).toBe(400);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it("rejects inactive source staff", async () => {
    send
      .mockResolvedValueOnce({ Item: { status: "active" } })
      .mockResolvedValueOnce({ Item: { status: "inactive" } });
    const response = await call(
      createProgram,
      event({
        name: "New",
        providerId: "provider-1",
        existingStaff: { providerManagerId: "staff" },
      }),
    );
    expect(response.statusCode).toBe(400);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it.each([
    [
      { lastName: "Lee", phone: "4155550100", email: "sam@example.org" },
      "name_required",
    ],
    [
      {
        firstName: "Sam",
        lastName: "Lee",
        phone: "4155550100",
        email: "invalid",
      },
      "valid_email_required",
    ],
  ])(
    "rejects invalid first staff before writing a program",
    async (firstStaff, error) => {
      const response = await call(
        createProgram,
        event({ name: "Program", providerId: "provider-1", firstStaff }),
      );
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(String(response.body))).toEqual({ error });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    [true, "other", "user-1"],
    [false, "user-1", null],
    [false, "other", "other"],
    [true, undefined, "user-1"],
  ])(
    "atomically saves staff and primary contact (%s, %s)",
    async (isPrimaryContact, previousId, expectedId) => {
      const user = {
        userId: "user-1",
        firstName: "Sam",
        lastName: "Lee",
        email: "sam@example.org",
        phone: "4155550100",
        status: "active",
        siteManager: false,
      };
      const oldContact = { firstName: "Other", email: "other@example.org" };
      send
        .mockResolvedValueOnce({ Item: user })
        .mockResolvedValueOnce({
          Item: {
            status: "active",
            primaryContactUserId: previousId,
            contact: oldContact,
            updatedAt: "version-1",
          },
        })
        .mockResolvedValueOnce({});
      const response = await call(
        updateProgramUser,
        event(
          { ...user, firstName: "Samuel", isPrimaryContact },
          { programId: "program-1", userId: "user-1" },
        ),
      );
      expect(response.statusCode).toBe(200);
      const transaction = send.mock.calls[2][0];
      expect(transaction).toBeInstanceOf(TransactWriteCommand);
      expect(transaction.input.TransactItems).toHaveLength(2);
      const [staff, program] = transaction.input.TransactItems;
      expect(staff.Update.ExpressionAttributeValues[":firstName"]).toBe(
        "Samuel",
      );
      expect(program.Update.ExpressionAttributeValues[":version"]).toBe(
        "version-1",
      );
      if (expectedId)
        expect(program.Update.ExpressionAttributeValues[":primary"]).toBe(
          expectedId,
        );
      else
        expect(program.Update.UpdateExpression).toContain(
          "REMOVE primaryContactUserId",
        );
      expect(program.Update.ExpressionAttributeValues[":contact"]).toEqual(
        isPrimaryContact
          ? expect.objectContaining({ firstName: "Samuel", email: user.email })
          : previousId === "user-1"
            ? {}
            : oldContact,
      );
    },
  );

  it("refreshes legacy primary contact details when editing the matched staff member", async () => {
    const user = {
      firstName: "Sam",
      lastName: "Lee",
      email: "sam@example.org",
      phone: "4155550100",
      status: "active",
    };
    send
      .mockResolvedValueOnce({ Item: user })
      .mockResolvedValueOnce({
        Item: { status: "active", contact: { ...user }, updatedAt: "v1" },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      updateProgramUser,
      event(
        {
          ...user,
          phone: "4155550101",
          email: "updated@example.org",
          isPrimaryContact: true,
        },
        { programId: "p1", userId: "u1" },
      ),
    );
    expect(response.statusCode).toBe(200);
    const values =
      send.mock.calls[2][0].input.TransactItems[1].Update
        .ExpressionAttributeValues;
    expect(values[":primary"]).toBe("u1");
    expect(values[":contact"].phone).toBe("4155550101");
    expect(values[":contact"].email).toBe("updated@example.org");
  });

  it("returns a conflict when the primary contact changed concurrently", async () => {
    send
      .mockResolvedValueOnce({
        Item: { status: "active", email: "sam@example.org" },
      })
      .mockResolvedValueOnce({ Item: { status: "active", updatedAt: "v1" } })
      .mockRejectedValueOnce(
        Object.assign(new Error("conflict"), {
          name: "TransactionCanceledException",
        }),
      );
    const response = await call(
      updateProgramUser,
      event(
        {
          firstName: "Sam",
          lastName: "Lee",
          email: "sam@example.org",
          phone: "4155550100",
          isPrimaryContact: true,
        },
        { programId: "p1", userId: "u1" },
      ),
    );
    expect(response.statusCode).toBe(409);
  });

  it("loads a program with sites and users", async () => {
    send
      .mockResolvedValueOnce({ Item: { programId: "program-1" } })
      .mockResolvedValueOnce({ Items: [{ siteId: "site-1" }] })
      .mockResolvedValueOnce({ Items: [{ userId: "user-1" }] });
    const response = await call(
      getProgram,
      event(undefined, { programId: "program-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toMatchObject({
      sites: [{ siteId: "site-1" }],
      users: [{ userId: "user-1" }],
    });
  });

  it("paginates program Site and user projections", async () => {
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: { programId: "program-1" } };
      }
      const prefix = command.input.ExpressionAttributeValues[":prefix"];
      if (!command.input.ExclusiveStartKey) {
        return {
          Items: [
            prefix === "SITE#" ? { siteId: "site-1" } : { userId: "user-1" },
          ],
          LastEvaluatedKey: {
            pk: "PROGRAM#program-1",
            sk: `${prefix}cursor`,
          },
        };
      }
      return {
        Items: [
          prefix === "SITE#" ? { siteId: "site-2" } : { userId: "user-2" },
        ],
      };
    });

    const response = await call(
      getProgram,
      event(undefined, { programId: "program-1" }),
    );

    expect(JSON.parse(String(response.body))).toMatchObject({
      sites: [{ siteId: "site-1" }, { siteId: "site-2" }],
      users: [{ userId: "user-1" }, { userId: "user-2" }],
    });
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("assigns a Program without active Sites to another provider", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          providerId: "provider-2",
          name: "Provider Two",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          programId: "program-1",
          name: "Program One",
          providerId: "provider-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});
    const response = await call(
      assignProgramToProvider,
      event({ programId: "program-1" }, { providerId: "provider-2" }),
    );
    expect(response.statusCode).toBe(200);
    const transaction = send.mock.calls[3][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(4);
  });

  it("does not move a Program that has active Sites", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          providerId: "provider-2",
          name: "Provider Two",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          programId: "program-1",
          name: "Program One",
          providerId: "provider-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        Items: [{ siteId: "site-1", status: "active" }],
      });
    const response = await call(
      assignProgramToProvider,
      event({ programId: "program-1" }, { providerId: "provider-2" }),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "program_has_sites",
    });
  });

  it("creates a non-authenticating program contact atomically", async () => {
    send
      .mockResolvedValueOnce({
        Item: { programId: "program-1", status: "active" },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      createProgramUser,
      event(
        {
          firstName: "Sam",
          lastName: "Lee",
          phone: "415-555-0100",
          phoneExtension: "123",
          email: "SAM@example.org",
          siteManager: true,
        },
        { programId: "program-1" },
      ),
    );
    expect(response.statusCode).toBe(201);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems[0].Put.Item).toMatchObject({
      pk: "PROGRAM#program-1",
      type: "programUser",
      firstName: "Sam",
      lastName: "Lee",
      email: "sam@example.org",
      phoneExtension: "123",
      siteManager: true,
      status: "active",
      siteAssignmentCount: 0,
    });
  });

  it("rejects a program contact without a valid email", async () => {
    const response = await call(
      createProgramUser,
      event(
        {
          firstName: "Sam",
          lastName: "Lee",
          phone: "415-555-0100",
          email: "not-an-email",
        },
        { programId: "program-1" },
      ),
    );
    expect(response.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("updates a program contact in place", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          userId: "user-1",
          status: "active",
          email: "sam@example.org",
          siteManager: false,
        },
      })
      .mockResolvedValueOnce({ Attributes: { userId: "user-1" } });
    const response = await call(
      updateProgramUser,
      event(
        {
          firstName: "Sam",
          lastName: "Lee",
          phone: "415-555-0101",
          email: "sam@example.org",
        },
        { programId: "program-1", userId: "user-1" },
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
  });

  it("lets managers edit contact details while preserving identity and role", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          userId: "user-1",
          status: "active",
          email: "sam@example.org",
          siteManager: true,
        },
      })
      .mockResolvedValueOnce({ Attributes: { userId: "user-1" } });
    const response = await call(
      updateProgramUser,
      event(
        {
          firstName: "Samuel",
          lastName: "Lee",
          phone: "415-555-0102",
          email: "sam@example.org",
          siteManager: true,
        },
        { programId: "program-1", userId: "user-1" },
        "compliance-manager",
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
  });

  it.each([
    [
      "change the contact email",
      true,
      { email: "other@example.org", siteManager: true },
    ],
    [
      "clear the Site manager role",
      true,
      { email: "sam@example.org", siteManager: false },
    ],
    [
      "set the Site manager role",
      false,
      { email: "sam@example.org", siteManager: true },
    ],
  ])(
    "does not let managers %s",
    async (_label, currentRole, restrictedValues) => {
      send.mockResolvedValueOnce({
        Item: {
          userId: "user-1",
          status: "active",
          email: "sam@example.org",
          siteManager: currentRole,
        },
      });
      const response = await call(
        updateProgramUser,
        event(
          {
            firstName: "Sam",
            lastName: "Lee",
            phone: "415-555-0101",
            ...restrictedValues,
          },
          { programId: "program-1", userId: "user-1" },
          "compliance-manager",
        ),
      );
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(String(response.body))).toEqual({
        error: "supervisor_required",
      });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("archives unassigned staff with an atomic contact revision guard", async () => {
    send
      .mockResolvedValueOnce({
        Item: { userId: "user-1", status: "active", siteManager: false },
      })
      .mockResolvedValueOnce({
        Item: {
          programId: "program-1",
          updatedAt: "version",
          staffContactRevision: "revision",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});
    const response = await call(
      deactivateProgramUser,
      event(undefined, { programId: "program-1", userId: "user-1" }),
    );
    expect(response.statusCode).toBe(200);
    const tx = send.mock.calls[3][0];
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    expect(tx.input.TransactItems[1].Update.ConditionExpression).toContain(
      "siteAssignmentCount = :zero",
    );
    expect(
      tx.input.TransactItems[0].Update.ExpressionAttributeValues,
    ).toMatchObject({
      ":previous": "revision",
      ":version": "version",
      ":userId": "user-1",
    });
  });

  it("does not archive staff when dependencies change during removal", async () => {
    send
      .mockResolvedValueOnce({ Item: { userId: "user-1", status: "active" } })
      .mockResolvedValueOnce({ Item: { programId: "program-1" } })
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(
        Object.assign(new Error("conflict"), {
          name: "TransactionCanceledException",
        }),
      );
    const response = await call(
      deactivateProgramUser,
      event(undefined, { programId: "program-1", userId: "user-1" }),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body)).error).toBe("program_user_in_use");
  });

  it.each([false])(
    "requires reassignment before removing program primary staff (%s)",
    async (siteManager) => {
      send
        .mockResolvedValueOnce({
          Item: { userId: "user-1", status: "active", siteManager },
        })
        .mockResolvedValueOnce({ Item: { primaryContactUserId: "user-1" } });
      const response = await call(
        deactivateProgramUser,
        event(undefined, { programId: "program-1", userId: "user-1" }),
      );
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(String(response.body)).error).toBe(
        "program_primary_contact_in_use",
      );
      expect(
        send.mock.calls.every(([command]) => command instanceof GetCommand),
      ).toBe(true);
    },
  );

  it.each([false])(
    "protects unassigned site primary contacts, including later pages (%s)",
    async (siteManager) => {
      const cursor = { pk: "PROGRAM#program-1", sk: "SITE#old" };
      send
        .mockResolvedValueOnce({
          Item: {
            userId: "user-1",
            status: "active",
            siteManager,
            siteAssignmentCount: 0,
          },
        })
        .mockResolvedValueOnce({ Item: { programId: "program-1" } })
        .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: cursor })
        .mockResolvedValueOnce({
          Items: [{ siteId: "site-1", status: "inactive" }],
        })
        .mockResolvedValueOnce({ Item: { primaryContactUserId: "user-1" } });
      const response = await call(
        deactivateProgramUser,
        event(undefined, { programId: "program-1", userId: "user-1" }),
      );
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(String(response.body)).error).toBe(
        "site_primary_contact_in_use",
      );
      expect(send.mock.calls[3][0].input.ExclusiveStartKey).toEqual(cursor);
      expect(
        send.mock.calls.some(
          ([command]) => command instanceof TransactWriteCommand,
        ),
      ).toBe(false);
    },
  );

  it("marks a non-primary manager removing before clearing assignments and deleting staff", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          userId: "user-1",
          email: "manager@example.org",
          status: "active",
          siteManager: true,
        },
      })
      .mockResolvedValueOnce({ Item: { programId: "program-1" } })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Items: [{ siteId: "site-1", status: "active" }],
      })
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", primaryContactUserId: "other" },
      })
      .mockResolvedValueOnce({ Item: { userId: "user-1" } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const response = await call(
      deactivateProgramUser,
      event(undefined, { programId: "program-1", userId: "user-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(
      send.mock.calls[3][0].input.TransactItems[1].Update
        .ExpressionAttributeValues[":next"],
    ).toBe("removing");
    const tx = send.mock.calls[8][0].input.TransactItems;
    expect(tx[0].Delete.Key.sk).toBe("ASSIGNED_USER#user-1");
    expect(tx.some((/** @type {any} */ item) => item.Update)).toBe(false);
    expect(send.mock.calls[9][0]).toBeInstanceOf(DeleteCommand);
  });

  it.each([false, true])(
    "deletes primary managers and clears contacts on inactive sites (legacy %s)",
    async (legacy) => {
      send
        .mockResolvedValueOnce({
          Item: {
            userId: "user-1",
            email: "manager@example.org",
            status: "active",
            siteManager: true,
          },
        })
        .mockResolvedValueOnce({
          Item: {
            programId: "program-1",
            updatedAt: "version",
            ...(legacy
              ? { contact: { email: "manager@example.org" } }
              : { primaryContactUserId: "user-1" }),
          },
        })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({
          Items: [],
          LastEvaluatedKey: { pk: "PROGRAM#program-1", sk: "SITE#old" },
        })
        .mockResolvedValueOnce({
          Items: [{ siteId: "site-1", status: "inactive" }],
        })
        .mockResolvedValueOnce({
          Item: { siteId: "site-1", primaryContactUserId: "user-1" },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      const response = await call(
        deactivateProgramUser,
        event(undefined, { programId: "program-1", userId: "user-1" }),
      );
      expect(response.statusCode).toBe(200);
      const program = send.mock.calls[3][0].input.TransactItems[0].Update;
      expect(program.UpdateExpression).toContain(
        "REMOVE primaryContactUserId, contact",
      );
      expect(program.ConditionExpression).toContain("updatedAt = :version");
      const site = send.mock.calls[9][0].input.TransactItems[0].Update;
      expect(site.UpdateExpression).toContain(
        "REMOVE primaryContactUserId, primaryContact",
      );
      expect(site.ConditionExpression).toBe("primaryContactUserId = :userId");
      expect(send.mock.calls[10][0]).toBeInstanceOf(DeleteCommand);
    },
  );

  it("updates program details", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          programId: "program-1",
          name: "Program One",
          providerId: "provider-1",
          providerName: "Provider One",
          status: "active",
        },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      updateProgram,
      event({ name: "Renamed" }, { programId: "program-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems[1].Update.Key).toEqual({
      pk: "PROVIDER#provider-1",
      sk: "PROGRAM#program-1",
    });
    expect(transaction.input.TransactItems[2].Delete.Key.sk).toBe(
      "program one#program-1",
    );
    expect(transaction.input.TransactItems[3].Put.Item).toMatchObject({
      sk: "renamed#program-1",
      name: "Renamed",
    });
  });

  it("archives only the program and search row", async () => {
    send
      .mockResolvedValueOnce({
        Item: { programId: "program-1", name: "Program One" },
      })
      .mockResolvedValueOnce({ Attributes: { status: "inactive" } })
      .mockResolvedValueOnce({});
    const response = await call(
      deactivateProgram,
      event(undefined, { programId: "program-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteCommand);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });
});

/** @param {unknown} body @param {Record<string, string>} pathParameters @param {string} groups */
function event(
  body = undefined,
  pathParameters = {},
  groups = "compliance-supervisor",
) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": groups } },
      },
    },
  };
}

/** @param {Function} handler @param {any} request */
async function call(handler, request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await handler(request, {}, () => {})
  );
}
