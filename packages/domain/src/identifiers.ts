import { z } from 'zod';

export const entityIdSchema = z.string().uuid();

export const connectorIdentifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const connectorVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
