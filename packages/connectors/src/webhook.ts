import { z } from 'zod';

/** Credential-only schema used to sign outbound row deliveries. */
export const webhookSigningCredentialSchema = z.strictObject({
  secret: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{43}$/,
      'Webhook signing secrets must be 32 bytes of unpadded base64url.'
    ),
});

export type WebhookSigningCredential = z.infer<
  typeof webhookSigningCredentialSchema
>;
