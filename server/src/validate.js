import { z } from 'zod';

export { z };

/** Parse req[part] with a zod schema; a bad request becomes a 400 with readable messages. */
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const err = new Error(result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
    err.status = 400;
    throw err;
  }
  return result.data;
}

export const frameSchema = z.object({
  pose: z.enum(['straight', 'left', 'right']),
  image: z.string().min(10).max(2_000_000),
});

export const scanSchema = z.object({
  challengeId: z.uuid(),
  frames: z.array(frameSchema).length(3),
});

export const codeSchema = z.string().regex(/^\d{6}$/, '6-digit code expected');
