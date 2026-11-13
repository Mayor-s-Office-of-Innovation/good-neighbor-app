// Real transactions, invoked by test-device-context-sessions.mjs in its isolated DB.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { redeemEnrollmentGrant } from "../src/handlers/enrollment.js";
import { enrollmentCodeVerifier } from "../src/handlers/enrollment-codes.js";
import { handler as probeCode } from "../src/handlers/site-code.js";
import { cancelStaffGrant } from "../src/handlers/manager-access.js";
import { cancelManagerGrant } from "../src/handlers/admin-manager-grants.js";
import { cancelProviderManagerGrant } from "../src/handlers/admin-provider-managers.js";

export async function reusableEnrollmentCases(
  t,
  { ddb, table, allowed, supervisor },
) {
  const put = (Item) => ddb.send(new PutCommand({ TableName: table, Item }));
  const get = async (Key) =>
    (
      await ddb.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  const rows = async (pk, prefix) =>
    (
      await ddb.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ConsistentRead: true,
        }),
      )
    ).Items;
  const request = (body) => ({
    body: JSON.stringify(body),
    headers: {},
    requestContext: { http: { sourceIp: "192.0.2.20" } },
  });
  for (const [index, role] of ["manager", "general", "provider"].entries()) {
    await t.test(
      `${role}: reusable invitation, independent sessions, expiry, revocation and cancellation`,
      async () => {
        const siteId = `reusable-${role}`;
        const providerId = `reusable-provider-${role}`;
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 3600000).toISOString();
        const token = `synthetic-invitation-${role}`;
        const code = `ZZZZZ${index}`;
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const codeHash = await enrollmentCodeVerifier(code);
        const site = {
          pk: `SITE#${siteId}`,
          sk: "#META",
          siteId,
          name: "Synthetic Site",
          status: "active",
          providerId,
          siteCredentialGeneration: 0,
          providerAccessGeneration: 0,
        };
        const membership = {
          pk: role === "provider" ? `PROVIDER#${providerId}` : site.pk,
          sk:
            role === "provider"
              ? "PROVIDER_MANAGER#member"
              : "MANAGER_MEMBERSHIP#member",
          membershipId: "member",
          status: "active",
          generation: 1,
          email: "synthetic@example.test",
          name: "Synthetic Manager",
        };
        await put(site);
        await put(membership);
        await put({
          pk: `PROVIDER#${providerId}`,
          sk: "#META",
          providerId,
          name: "Synthetic Provider",
          status: "active",
        });
        await put({
          ...site,
          pk: `PROVIDER#${providerId}`,
          sk: `SITE#${siteId}`,
          siteName: site.name,
        });
        await put({
          pk: site.pk,
          sk: "DEVICE_BINDING#issuer",
          bindingId: "issuer",
          status: "active",
          accessLevel: "manager",
          membershipId: "member",
          membershipGeneration: 1,
          siteCredentialGeneration: 0,
        });
        const grant = {
          pk: membership.pk,
          sk: `${role === "provider" ? "PROVIDER_MANAGER_GRANT" : role === "general" ? "STAFF_GRANT" : "MANAGER_GRANT"}#${now}#invitation`,
          grantId: randomUUID(),
          siteId,
          providerId,
          membershipId: "member",
          membershipGeneration: 1,
          ...(role === "provider"
            ? { scope: "provider" }
            : { siteCredentialGeneration: 0 }),
          accessLevel: role === "general" ? "general" : "manager",
          issuedByBindingId: "issuer",
          issuerMembershipId: "member",
          issuerMembershipGeneration: 1,
          tokenHash,
          codeHash,
          status: "pending",
          expiresAt,
          createdAt: now,
        };
        await put(grant);
        for (const hash of [tokenHash, codeHash])
          await put({
            pk: `ENROLLMENT_TOKEN#${hash}`,
            sk: "#META",
            grantId: grant.grantId,
            grantPk: grant.pk,
            grantSk: grant.sk,
            expiresAt,
          });
        const pointer = {
          pk: grant.pk,
          sk: `${role === "provider" ? "PROVIDER_MANAGER_GRANT_CURRENT" : "MANAGER_GRANT_CURRENT"}#member`,
          grantId: grant.grantId,
          expiresAt,
        };
        if (role !== "general") await put(pointer);
        const link = { grantId: grant.grantId, token };
        const firstResponse = await redeemEnrollmentGrant(request(link));
        assert.equal(firstResponse.statusCode, 201, firstResponse.body);
        const first = JSON.parse(firstResponse.body);
        assert.equal(first.enrollmentGrantId, grant.grantId);
        assert.equal(await allowed(first.token), true);
        // The first response could have been discarded in an email webview. The
        // same invitation/code still establishes independent browser access.
        assert.equal((await probeCode(request({ code }))).statusCode, 200);
        const secondResponse = await redeemEnrollmentGrant(request({ code }));
        assert.equal(secondResponse.statusCode, 201, secondResponse.body);
        const second = JSON.parse(secondResponse.body);
        assert.notEqual(first.bindingId, second.bindingId);
        assert.notEqual(first.physicalDeviceId, second.physicalDeviceId);
        assert.equal(await allowed(first.token), true);
        assert.equal(await allowed(second.token), true);
        assert.equal(
          (await get({ pk: grant.pk, sk: grant.sk })).expiresAt,
          expiresAt,
        );
        assert.equal(
          (await rows(membership.pk, membership.sk.split("#")[0] + "#")).length,
          1,
        );
        if (role !== "general")
          assert.equal(
            (await get({ pk: pointer.pk, sk: pointer.sk })).grantId,
            grant.grantId,
          );
        // Explicit invalidation remains effective after prior successful use.
        await put({
          ...grant,
          status: "redeemed",
          expiresAt: "2000-01-01T00:00:00.000Z",
        });
        assert.equal(
          (await redeemEnrollmentGrant(request(link))).statusCode,
          410,
        );
        await put({ ...grant, status: "redeemed" });
        await put({ ...membership, status: "inactive" });
        assert.equal(
          (await redeemEnrollmentGrant(request(link))).statusCode,
          403,
        );
        await put({ ...membership, generation: 2 });
        assert.equal(
          (await redeemEnrollmentGrant(request(link))).statusCode,
          403,
        );
        await put(membership);
        if (role !== "provider") {
          await put({ ...site, siteCredentialGeneration: 1 });
          assert.equal(
            (await redeemEnrollmentGrant(request(link))).statusCode,
            403,
          );
          await put(site);
        }
        // Concurrent browsers may encounter a transaction conflict; retrying
        // that conflict must succeed without invalidating either session.
        const concurrent = await Promise.all([
          redeemEnrollmentGrant(request(link)),
          redeemEnrollmentGrant(request(link)),
        ]);
        for (let response of concurrent) {
          if (response.statusCode === 409)
            response = await redeemEnrollmentGrant(request(link));
          assert.equal(response.statusCode, 201, response.body);
          assert.equal(await allowed(JSON.parse(response.body).token), true);
        }
        const cancel =
          role === "general"
            ? await cancelStaffGrant({
                pathParameters: { grantId: grant.grantId },
                requestContext: {
                  authorizer: {
                    lambda: {
                      "claims.custom:siteId": siteId,
                      "claims.accessLevel": "manager",
                      "claims.sub": "issuer",
                    },
                  },
                },
              })
            : await (
                role === "provider"
                  ? cancelProviderManagerGrant
                  : cancelManagerGrant
              )(supervisor({ siteId, providerId, grantId: grant.grantId }));
        assert.equal(cancel.statusCode, 200, cancel.body);
        for (const credentials of [link, { code }])
          assert.notEqual(
            (await redeemEnrollmentGrant(request(credentials))).statusCode,
            201,
          );
        assert.equal(
          (await get({ pk: grant.pk, sk: grant.sk })).status,
          "cancelled",
        );
        // Cancelling an invitation stops future enrollment, not established access.
        assert.equal(await allowed(first.token), true);
        assert.equal(await allowed(second.token), true);
        if (role !== "general") {
          // Older releases deleted pointers on first use. An old used grant
          // must remain cancellable when a newer invitation owns the pointer.
          await put({ ...grant, status: "redeemed" });
          await put({ ...pointer, grantId: "synthetic-newer-invitation" });
          const cancelOlder = await (
            role === "provider"
              ? cancelProviderManagerGrant
              : cancelManagerGrant
          )(supervisor({ siteId, providerId, grantId: grant.grantId }));
          assert.equal(cancelOlder.statusCode, 200, cancelOlder.body);
          assert.equal(
            (await get({ pk: pointer.pk, sk: pointer.sk })).grantId,
            "synthetic-newer-invitation",
          );
        }
      },
    );
  }
}
