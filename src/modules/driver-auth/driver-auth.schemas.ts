export const driverPublicSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string', format: 'uuid' },
    fullName: { type: 'string' },
    nationalId: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'suspended'] },
    registrationStep: { type: ['integer', 'null'] },
    phone: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    photoUrl: { type: ['string', 'null'] },
    isAvailable: { type: 'boolean' },
    avgRating: { type: ['string', 'null'] },
  },
} as const;

export const driverLoginSchema = {
  body: {
    type: 'object',
    required: ['nationalId', 'password'],
    additionalProperties: false,
    properties: {
      nationalId: { type: 'string', minLength: 5, maxLength: 20 },
      password: { type: 'string', minLength: 1, maxLength: 72 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        driver: driverPublicSchema,
      },
    },
  },
} as const;

export const driverMeSchema = {
  response: {
    200: driverPublicSchema,
  },
} as const;
