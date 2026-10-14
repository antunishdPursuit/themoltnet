import type { TSchema } from 'typebox';

type Schema = Record<string, unknown>;

/** Types a contract node may declare. `null` only pairs with one of these. */
const PRIMITIVE_TYPES = ['string', 'number', 'integer', 'boolean'];
/** JavaScript kinds a literal or enum value may have; `integer` is not one. */
const LITERAL_KINDS = ['string', 'number', 'boolean'];
/** Allowed on every contract node. */
const ANNOTATION_KEYS = ['description', 'title'];
/** The bounds the contract keeps, per primitive type. */
const BOUND_KEYS: Record<string, string[]> = {
  string: ['minLength', 'maxLength'],
  number: ['minimum', 'maximum'],
  integer: ['minimum', 'maximum'],
  boolean: [],
};
/** The task contract validator rejects schemas nested deeper than this. */
const MAX_DEPTH = 10;

function unsupported(message: string): never {
  throw new Error(`unsupported output contract schema: ${message}`);
}

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function annotations(source: Schema): Schema {
  const result: Schema = {};
  for (const key of ANNOTATION_KEYS) {
    if (typeof source[key] === 'string') result[key] = source[key];
  }
  return result;
}

/** Literal values sharing one JavaScript kind, as a typed enum node. */
function literalEnum(values: unknown[]): Schema {
  const kind = typeof values[0];
  if (
    values.length === 0 ||
    !LITERAL_KINDS.includes(kind) ||
    values.some((value) => typeof value !== kind)
  ) {
    unsupported('literals and enums must hold values of one primitive type');
  }
  return { type: kind, enum: values };
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
  return project(schema as Schema, 0);
}

function project(source: Schema, depth: number): Schema {
  if (depth > MAX_DEPTH) unsupported(`nested deeper than ${MAX_DEPTH} levels`);
  if (Array.isArray(source.anyOf)) return projectUnion(source, depth);
  if ('const' in source) {
    return { ...literalEnum([source.const]), ...annotations(source) };
  }
  if (Array.isArray(source.enum) && source.type === undefined) {
    // `Type.Enum` carries no `type`; the contract requires one.
    return { ...literalEnum(source.enum), ...annotations(source) };
  }
  if (source.type === 'object') {
    if (!isSchema(source.properties)) {
      unsupported('objects need declared properties');
    }
    return {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(source.properties).map(([name, child]) => [
          name,
          project(child as Schema, depth + 1),
        ]),
      ),
      required: source.required ?? [],
      additionalProperties: false,
      ...annotations(source),
    };
  }
  if (source.type === 'array') {
    if (!isSchema(source.items)) unsupported('arrays need an items schema');
    const result: Schema = {
      type: 'array',
      items: project(source.items, depth + 1),
    };
    for (const key of ['minItems', 'maxItems']) {
      if (source[key] !== undefined) result[key] = source[key];
    }
    return { ...result, ...annotations(source) };
  }
  return projectPrimitive(source);
}

/** A primitive, or `[primitive, 'null']`, with its bounds and enum. */
function projectPrimitive(source: Schema): Schema {
  const type = source.type;
  const nullable =
    Array.isArray(type) && type.length === 2 && type.includes('null');
  const base: unknown = nullable
    ? (type as unknown[]).find((value) => value !== 'null')
    : type;
  if (!PRIMITIVE_TYPES.includes(base as string)) {
    unsupported(`type ${JSON.stringify(type)}`);
  }
  const result: Schema = { type };
  for (const key of BOUND_KEYS[base as string]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  if (source.enum !== undefined) {
    const values = source.enum;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) =>
        value === null
          ? !nullable
          : base === 'integer'
            ? !Number.isInteger(value)
            : typeof value !== base,
      )
    ) {
      unsupported(`enum values must be of type ${String(base)}`);
    }
    result.enum = values;
  }
  return { ...result, ...annotations(source) };
}

/** Literal unions, and `T | null` for a primitive or literal-union `T`. */
function projectUnion(source: Schema, depth: number): Schema {
  const members = source.anyOf as unknown[];
  const others = members.filter(
    (member) => !(isSchema(member) && member.type === 'null'),
  );
  const nulls = members.length - others.length;
  if (others.length === 0 || nulls > 1) {
    unsupported(
      'unions need at least one non-null member and at most one null',
    );
  }
  let projected: Schema;
  if (others.length === 1) {
    projected = project(others[0] as Schema, depth);
  } else {
    const values = others.map((member) =>
      isSchema(member) && 'const' in member ? member.const : undefined,
    );
    if (values.includes(undefined)) {
      unsupported('unions must be literals of one primitive type, or T | null');
    }
    projected = literalEnum(values);
  }
  if (nulls === 0) return { ...projected, ...annotations(source) };
  if (!PRIMITIVE_TYPES.includes(projected.type as string)) {
    unsupported('only primitives can be nullable');
  }
  return {
    ...projected,
    type: [projected.type, 'null'],
    ...(Array.isArray(projected.enum)
      ? { enum: [...(projected.enum as unknown[]), null] }
      : {}),
    ...annotations(source),
  };
}
