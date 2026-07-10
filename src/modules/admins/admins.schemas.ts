import { adminPublicSchema } from '../auth/auth.schemas.js';

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export const listAdminsSchema = {
  response: {
    200: { type: 'array', items: adminPublicSchema },
  },
} as const;

export const getAdminSchema = {
  params: idParam,
  response: { 200: adminPublicSchema },
} as const;

export const createAdminSchema = {
  body: {
    type: 'object',
    required: ['username', 'fullName', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9._-]+$' },
      email: { type: ['string', 'null'], format: 'email' },
      fullName: { type: 'string', minLength: 3, maxLength: 120 },
      password: { type: 'string', minLength: 10, maxLength: 128 },
    },
  },
  response: { 201: adminPublicSchema },
} as const;

export const updateAdminSchema = {
  params: idParam,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      email: { type: ['string', 'null'], format: 'email' },
      fullName: { type: 'string', minLength: 3, maxLength: 120 },
      status: { type: 'string', enum: ['active', 'suspended'] },
    },
  },
  response: { 200: adminPublicSchema },
} as const;

export const updateAdminPasswordSchema = {
  params: idParam,
  body: {
    type: 'object',
    required: ['password'],
    additionalProperties: false,
    properties: {
      password: { type: 'string', minLength: 10, maxLength: 128 },
    },
  },
  response: {
    204: { type: 'null' },
  },
} as const;
