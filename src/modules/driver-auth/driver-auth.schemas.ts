import { personProperties } from '../drivers/drivers.schemas.js';

export const driverPublicSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string', format: 'uuid' },
    fullName: { type: 'string' },
    nationalId: { type: ['string', 'null'] },
    status: {
      type: 'string',
      enum: [
        'applicant', 'pending', 'scheduled', 'approved',
        'rejected', 'suspended', 'paused', 'overdue', 'penalized',
      ],
    },
    registrationStep: { type: ['integer', 'null'] },
    phone: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    photoUrl: { type: ['string', 'null'] },
    isAvailable: { type: 'boolean' },
    avgRating: { type: ['string', 'null'] },
    // Whether the admin already set the tariff start; false = approved but not yet
    // activated (the app shows a waiting screen instead of the home).
    tariffStarted: { type: 'boolean' },
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

/** Current active membership + benefits for the app's informational pre-screen. */
export const appMembershipSchema = {
  response: {
    200: {
      type: ['object', 'null'],
      properties: {
        name: { type: 'string' },
        priceUsd: { type: 'string' },
        benefits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
              description: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
  },
} as const;

/** The driver's alta/arrears debt for the app's deferred payment screen. */
export const appDebtSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        totalUsd: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              amountUsd: { type: 'string' },
            },
          },
        },
        hasPendingPayment: { type: 'boolean' },
        // Declared here or the serializer would strip it: the driver only learns
        // his payment was turned down through this field.
        rejected: {
          type: ['object', 'null'],
          properties: {
            amountUsd: { type: 'string' },
            reason: { type: ['string', 'null'] },
            reviewedAt: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

/**
 * Self-service edit of the driver's own data. The whitelist is the schema: no
 * names, no national id (identity verified by an admin), no status. Changing
 * the password requires the current one.
 */
export const appSelfUpdateSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      phone: { type: 'string', maxLength: 30 },
      email: { type: 'string', format: 'email', maxLength: 120 },
      address: { type: 'string', maxLength: 250 },
      password: { type: 'string', minLength: 6, maxLength: 72 },
      currentPassword: { type: 'string', maxLength: 72 },
    },
  },
  response: {
    200: driverPublicSchema,
  },
} as const;

/** The driver marks himself available (or not) for work. */
export const appAvailabilitySchema = {
  body: {
    type: 'object',
    required: ['available'],
    additionalProperties: false,
    properties: { available: { type: 'boolean' } },
  },
  response: {
    200: {
      type: 'object',
      properties: { isAvailable: { type: 'boolean' } },
    },
  },
} as const;

/**
 * Account standing for the driver's own profile. Every date is an ISO string;
 * `upcoming` (charge already emitted) and `nextChargeAt` (when it will be
 * emitted) never both carry a value.
 */
export const appAccountSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        driverStatus: { type: 'string' },
        reactivatesAt: { type: ['string', 'null'] },
        // Declared or the serializer drops it: it is how the app learns WHEN he
        // starts, instead of only that he cannot work yet.
        tariffStartsAt: { type: ['string', 'null'] },
        paidUntil: { type: ['string', 'null'] },
        upcoming: {
          type: ['object', 'null'],
          properties: {
            amountUsd: { type: 'string' },
            periodStart: { type: 'string' },
            periodEnd: { type: 'string' },
          },
        },
        nextChargeAt: { type: ['string', 'null'] },
        weeksOwed: { type: 'integer' },
        penaltyCount: { type: 'integer' },
        capWeeks: { type: 'integer' },
        planPriceUsd: { type: ['string', 'null'] },
      },
    },
  },
} as const;

/** Active tariffs for the app's enrollment summary (the app uses the weekly one). */
export const appPlansSchema = {
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          priceUsd: { type: 'string' },
          billingPeriod: { type: 'string' },
        },
      },
    },
  },
} as const;

/**
 * Self-service registration (app) — STEP 1 ONLY (proposal: solicitudes-app):
 * personal data + credentials + privacy consent. No vehicles, documents or
 * payment here — those are added afterwards from the app once the driver logs
 * in as an `applicant`. The service enforces credentials and the privacy check.
 */
export const appRegisterBody = {
  type: 'object',
  required: ['firstName', 'lastName', 'nationalId', 'password', 'acceptedPrivacy'],
  additionalProperties: false,
  properties: {
    ...personProperties,
    // Privacy consent captured at registration; the service requires it true.
    acceptedPrivacy: { type: 'boolean' },
  },
} as const;

export const driverRegisterSchema = {
  body: appRegisterBody,
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
