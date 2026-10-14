import { validateOutputContract } from '@moltnet/tasks';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';

import { toOutputContractSchema } from './output-contract-schema.js';

describe('toOutputContractSchema', () => {
  it('projects nested fields into the task output contract subset', () => {
    const resultSchema = Type.Object({
      version: Type.Literal(1),
      findings: Type.Array(
        Type.Object({
          id: Type.String({ pattern: '^[a-z]+$' }),
          verdict: Type.Union([Type.Literal('keep'), Type.Literal('remove')]),
          section: Type.Optional(Type.String()),
        }),
        { maxItems: 3 },
      ),
    });

    expect(toOutputContractSchema(resultSchema)).toEqual({
      type: 'object',
      properties: {
        version: { type: 'number', enum: [1] },
        findings: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              verdict: { type: 'string', enum: ['keep', 'remove'] },
              section: { type: 'string' },
            },
            required: ['id', 'verdict'],
            additionalProperties: false,
          },
        },
      },
      required: ['version', 'findings'],
      additionalProperties: false,
    });
  });

  it('rejects unions outside the contract subset', () => {
    expect(() =>
      toOutputContractSchema(
        Type.Union([Type.Literal('pass'), Type.Literal(1)]),
      ),
    ).toThrow('literals of one primitive type');
  });

  it('keeps descriptions, titles, enums, and nullable primitives', () => {
    // Arrange
    const resultSchema = Type.Object(
      {
        status: Type.Enum(['open', 'closed'], { description: 'Issue state' }),
        owner: Type.Union([Type.String(), Type.Null()], {
          description: 'Login, or null when unassigned',
        }),
      },
      { title: 'Issue' },
    );

    // Act
    const projected = toOutputContractSchema(resultSchema);

    // Assert
    expect(projected).toEqual({
      type: 'object',
      title: 'Issue',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'closed'],
          description: 'Issue state',
        },
        owner: {
          type: ['string', 'null'],
          description: 'Login, or null when unassigned',
        },
      },
      required: ['status', 'owner'],
      additionalProperties: false,
    });
    expect(
      validateOutputContract('freeform', {
        outputContract: { version: 1, schema: projected },
      }),
    ).toEqual([]);
  });

  it('returns a schema already inside the contract subset unchanged', () => {
    // Arrange
    const contract = {
      type: 'object',
      description: 'Rooms',
      properties: {
        kind: { type: 'string', enum: ['a', 'b'], maxLength: 1 },
        note: { type: ['string', 'null'] },
        sizes: { type: 'array', items: { type: 'integer', minimum: 0 } },
      },
      required: ['kind'],
      additionalProperties: false,
    };

    // Act
    const projected = toOutputContractSchema(contract);

    // Assert
    expect(projected).toEqual(contract);
  });
});
