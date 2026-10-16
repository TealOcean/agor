import { z } from 'zod';
import {
  CustomProviderBaseURLSchema,
  CustomProviderSchema,
} from '../shared/custom-provider-schema.js';

export const OpenCodeAuthParamsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('discover'),
    directory: z.string().min(1).optional(),
  }),
  z.object({ operation: z.literal('read-model-catalog') }).strict(),
  z.object({
    operation: z.literal('connect-api-key'),
    providerId: z.string().trim().min(1).max(200),
    apiKey: z.string().trim().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    operation: z.literal('disconnect'),
    providerId: z.string().trim().min(1).max(200),
  }),
  z.object({
    operation: z.literal('connect-oauth'),
    providerId: z.string().trim().min(1).max(200),
    method: z.number().int().nonnegative(),
    inputs: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    operation: z.literal('save-custom-provider'),
    create: z.boolean(),
    provider: CustomProviderSchema,
    apiKey: z.string().trim().min(1).optional(),
    clearApiKey: z.boolean().optional(),
  }),
  z.object({
    operation: z.literal('remove-custom-provider'),
    providerId: z.string().trim().min(1).max(64),
  }),
  z.object({
    operation: z.literal('probe-custom-provider-models'),
    baseURL: CustomProviderBaseURLSchema,
    apiKey: z.string().trim().min(1).optional(),
    providerId: z.string().trim().min(1).max(64).optional(),
  }),
]);

export interface OpenCodeAuthPayload {
  command: 'opencode.auth';
  dataHome: string;
  params: z.infer<typeof OpenCodeAuthParamsSchema>;
}
