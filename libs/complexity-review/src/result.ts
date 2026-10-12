import type { Rubric } from '@moltnet/tasks';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';

export const ComplexityReviewDecision = Type.Object(
  {
    scores: Type.Array(
      Type.Object(
        {
          criterionId: Type.String({ minLength: 1 }),
          status: Type.Union([
            Type.Literal('pass'),
            Type.Literal('fail'),
            Type.Literal('unclear'),
          ]),
          rationale: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    verdict: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export const ComplexityReviewOutput = Type.Object(
  {
    ...ComplexityReviewDecision.properties,
    composite: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);
export type ComplexityReviewOutput = Static<typeof ComplexityReviewOutput>;

export function finalizeComplexityReviewDecision(
  output: unknown,
  rubric: Rubric,
): ComplexityReviewOutput {
  if (!Value.Check(ComplexityReviewDecision, output)) {
    throw new Error(
      'accepted task output is not a valid ComplexityReviewDecision',
    );
  }
  if (output.scores.length !== rubric.criteria.length) {
    throw new Error('scores length does not match rubric criteria length');
  }
  let assessedWeight = 0;
  let passedWeight = 0;
  for (const [index, criterion] of rubric.criteria.entries()) {
    const score = output.scores[index];
    if (score.criterionId !== criterion.id) {
      throw new Error(`scores[${index}] has unexpected criterionId`);
    }
    if (score.status !== 'unclear') {
      assessedWeight += criterion.weight;
      if (score.status === 'pass') passedWeight += criterion.weight;
    }
  }
  return {
    ...output,
    ...(assessedWeight === 0
      ? {}
      : { composite: passedWeight / assessedWeight }),
  };
}
