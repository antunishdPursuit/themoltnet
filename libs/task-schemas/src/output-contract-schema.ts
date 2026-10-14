import type { TSchema } from 'typebox';

const PRIMITIVES = ['string', 'number', 'integer', 'boolean'];

/** `description` and `title` are allowed on every contract node. */
function annotations(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['description', 'title']) {
    if (typeof source[key] === 'string') result[key] = source[key];
  }
  return result;
}

/** `T | null` written as a TypeBox union, for a primitive `T`. */
function nullablePrimitive(
  members: unknown[],
): Record<string, unknown> | undefined {
  if (members.length !== 2) return undefined;
  const nulls = members.filter(
    (member) => (member as Record<string, unknown>)?.type === 'null',
  );
  const [other] = members.filter((member) => !nulls.includes(member));
  const type = (other as Record<string, unknown> | undefined)?.type;
  if (nulls.length !== 1 || !PRIMITIVES.includes(type as string)) {
    return undefined;
  }
  return other as Record<string, unknown>;
}

/**
 * Project a TypeBox schema onto the small JSON Schema subset accepted by task
 * output contracts. Callers retain their full schema for local validation of
 * constraints such as string patterns that this transport cannot express.
 *
 * A schema already inside the subset projects to itself, so the projection
 * can be applied to both TypeBox and plain JSON Schema inputs.
 */
export function toOutputContractSchema(
  schema: TSchema | Record<string, unknown>,
): Record<string, unknown> {
  const source = schema as Record<string, unknown>;
  if ('const' in source) {
    const value = source.const;
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error('output contract literals must be primitive values');
    }
    return { type: typeof value, enum: [value], ...annotations(source) };
  }
  if (Array.isArray(source.anyOf)) {
    const nullable = nullablePrimitive(source.anyOf);
    if (nullable) {
      const projected = toOutputContractSchema(nullable);
      return {
        ...projected,
        type: [projected.type, 'null'],
        ...annotations(source),
      };
    }
    const values = source.anyOf.map((member) =>
      member && typeof member === 'object'
        ? (member as Record<string, unknown>).const
        : undefined,
    );
    const kind = typeof values[0];
    if (
      values.length === 0 ||
      !['string', 'number', 'boolean'].includes(kind) ||
      values.some((value) => value === undefined || typeof value !== kind)
    ) {
      throw new Error(
        'output contract unions must contain literals of one primitive type, or one primitive and null',
      );
    }
    return { type: kind, enum: values, ...annotations(source) };
  }
  if (Array.isArray(source.enum) && source.type === undefined) {
    // `Type.Enum` carries no `type`; the contract requires one.
    const kind = typeof source.enum[0];
    if (
      !['string', 'number', 'boolean'].includes(kind) ||
      source.enum.some((value) => typeof value !== kind)
    ) {
      throw new Error('output contract enums must hold one primitive type');
    }
    return { type: kind, enum: source.enum, ...annotations(source) };
  }

  const type = source.type;
  if (type === 'object') {
    const properties = source.properties as Record<string, TSchema>;
    return {
      type,
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, child]) => [
          name,
          toOutputContractSchema(child),
        ]),
      ),
      required: source.required ?? [],
      additionalProperties: false,
      ...annotations(source),
    };
  }
  if (type === 'array') {
    const result: Record<string, unknown> = {
      type,
      items: toOutputContractSchema(source.items as TSchema),
    };
    for (const key of ['minItems', 'maxItems']) {
      if (source[key] !== undefined) result[key] = source[key];
    }
    return { ...result, ...annotations(source) };
  }
  const nullable =
    Array.isArray(type) &&
    type.length === 2 &&
    type.includes('null') &&
    PRIMITIVES.includes(type.find((value) => value !== 'null') as string);
  if (!nullable && !PRIMITIVES.includes(type as string)) {
    throw new Error(`unsupported output contract schema type ${String(type)}`);
  }
  const result: Record<string, unknown> = { type };
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'enum']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return { ...result, ...annotations(source) };
}
