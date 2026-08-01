/**
 * Payment method types OFFERED by the business (decision 2026-07-31): only
 * these 4. The DB enum `payment_method_type` still carries the old values
 * (paypal/crypto/contact) — removing them would be a destructive enum migration
 * for no gain — but the API refuses to create/update to anything outside this
 * list, so they can no longer appear.
 */
export const PAYMENT_METHOD_TYPES = [
  'bank_transfer',
  'pago_movil',
  'zelle',
  'binance',
] as const;

const paymentMethodSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    type: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

// Free-form per-type payload; the per-type required fields are checked in the service.
const details = { type: 'object', additionalProperties: true, maxProperties: 20 } as const;

export const listPaymentMethodsSchema = {
  response: { 200: { type: 'array', items: paymentMethodSchema } },
} as const;

export const createPaymentMethodSchema = {
  body: {
    type: 'object',
    required: ['name', 'type', 'details'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 120 },
      type: { type: 'string', enum: PAYMENT_METHOD_TYPES },
      details,
    },
  },
  response: { 201: paymentMethodSchema },
} as const;

export const updatePaymentMethodSchema = {
  params: idParam,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 120 },
      type: { type: 'string', enum: PAYMENT_METHOD_TYPES },
      details,
      isActive: { type: 'boolean' },
    },
  },
  response: { 200: paymentMethodSchema },
} as const;

export const deletePaymentMethodSchema = {
  params: idParam,
  response: { 204: { type: 'null' } },
} as const;
