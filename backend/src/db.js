import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Single shared DynamoDB Document Client. The base client reads region and
// (locally) AWS_ENDPOINT_URL_DYNAMODB straight from the environment, so pointing
// at DynamoDB Local needs no code change — just env vars. removeUndefinedValues
// lets us build item objects with optional attributes without pruning them by hand.
const client = new DynamoDBClient({});

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
