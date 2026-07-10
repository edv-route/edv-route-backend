export const adminPublicSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    username: { type: 'string' },
    email: { type: ['string', 'null'] },
    fullName: { type: 'string' },
    role: { type: 'string' },
    status: { type: 'string', enum: ['active', 'suspended'] },
    lastLoginAt: { type: ['string', 'null'] },
    createdBy: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

export const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 30 },
      password: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        admin: adminPublicSchema,
      },
    },
  },
} as const;

export const meSchema = {
  response: {
    200: adminPublicSchema,
  },
} as const;
