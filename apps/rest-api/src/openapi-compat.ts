import type { SwaggerTransformObject } from '@fastify/swagger';
import { UploadTaskArtifactQuery } from '@moltnet/tasks';

type Operation = {
  parameters?: Array<{
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  requestBody?: { required?: boolean };
};

// These routes accept an omitted body because preValidation supplies `{}`.
const optionalBodyPaths = ['approve', 'suspend', 'revoke'].map(
  (action) => `/crypto/signing-credentials/{id}/${action}`,
);

// Swagger 9.9 treats a query property named `contentEncoding` as a JSON Schema
// keyword and removes it while converting the query schema to parameters.
const artifactUploadPaths = [
  '/task-artifacts/staged',
  '/tasks/{taskId}/attempts/{attemptN}/artifacts',
];

export const transformOpenApi: SwaggerTransformObject = (document) => {
  if (!('openapiObject' in document)) return document.swaggerObject;
  const openapi = document.openapiObject;

  for (const path of optionalBodyPaths) {
    const operation = openapi.paths?.[path]?.post as Operation | undefined;
    if (operation?.requestBody) delete operation.requestBody.required;
  }

  for (const path of artifactUploadPaths) {
    const operation = openapi.paths?.[path]?.put as Operation | undefined;
    if (!operation) continue;
    const parameters = (operation.parameters ??= []);
    if (
      parameters.some(
        (parameter) =>
          parameter.in === 'query' && parameter.name === 'contentEncoding',
      )
    ) {
      continue;
    }
    const contentTypeIndex = parameters.findIndex(
      (parameter) =>
        parameter.in === 'query' && parameter.name === 'contentType',
    );
    parameters.splice(contentTypeIndex + 1, 0, {
      in: 'query',
      name: 'contentEncoding',
      required: false,
      schema: { ...UploadTaskArtifactQuery.properties.contentEncoding },
    });
  }

  return openapi;
};
