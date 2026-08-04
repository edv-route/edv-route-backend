import { registerBody } from '../drivers/drivers.schemas.js';

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

export const appRequirementsSchema = {
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          appliesTo: { type: 'string', enum: ['driver', 'vehicle'] },
          isRequired: { type: 'boolean' },
        },
      },
    },
  },
} as const;

export const appPaymentMethodsSchema = {
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          type: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
} as const;

export const appVehicleTypesSchema = {
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
        },
      },
    },
  },
} as const;

/**
 * Self-service registration (app): same body contract as the panel register;
 * the channel-specific obligations (credentials, >=1 vehicle, every required
 * document) are enforced in the service. Responds with a driver token so the
 * app can immediately upload files and submit the payment.
 */
export const driverRegisterSchema = {
  body: registerBody,
  response: {
    201: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        driver: driverPublicSchema,
        createdDocumentIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
        createdVehicles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              documentIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
            },
          },
        },
      },
    },
  },
} as const;
