import { personProperties } from '../drivers/drivers.schemas.js';

/**
 * Validation for the passenger side (proposal: docs/proposals/cliente).
 *
 * The person fields are the SAME ones the affiliate registration uses —
 * imported, not copied. Luis asked for the two forms to match, and importing is
 * what actually guarantees it: a copy drifts the first time somebody widens a
 * field on one side only. That includes the phone pattern (+58 and ten digits),
 * which is already right and is deliberately left alone.
 */

/** What the app shows about the signed-in client. */
export const clientPublicSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string', format: 'uuid' },
    fullName: { type: 'string' },
    firstName: { type: 'string' },
    middleName: { type: ['string', 'null'] },
    lastName: { type: 'string' },
    secondLastName: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    photoUrl: { type: ['string', 'null'] },
    birthDate: { type: ['string', 'null'] },
    address: { type: ['string', 'null'] },
    status: { type: 'string' },
    /**
     * Present only when this person is ALSO an affiliate — it lives on
     * `drivers`, not on `users`. The app can use it to offer the driver mode
     * to somebody who already has one.
     */
    nationalId: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
  },
} as const;

const authResponse = {
  200: {
    type: 'object',
    properties: {
      token: { type: 'string' },
      client: clientPublicSchema,
    },
  },
} as const;

export const clientLoginSchema = {
  body: {
    type: 'object',
    required: ['identifier', 'password'],
    additionalProperties: false,
    properties: {
      /**
       * Email OR phone, whichever he remembers (decision by Luis, 2026-08-31).
       * Deliberately NOT validated as one or the other here: a passenger who
       * mistypes deserves "datos incorrectos", not a lecture about formats, and
       * the lookup matches both columns anyway.
       */
      identifier: { type: 'string', minLength: 3, maxLength: 120 },
      password: { type: 'string', minLength: 1, maxLength: 72 },
    },
  },
  response: authResponse,
} as const;

export const clientRegisterSchema = {
  body: {
    type: 'object',
    required: ['firstName', 'lastName', 'email', 'password', 'acceptedPrivacy'],
    additionalProperties: false,
    properties: {
      firstName: personProperties.firstName,
      middleName: personProperties.middleName,
      lastName: personProperties.lastName,
      secondLastName: personProperties.secondLastName,
      birthDate: personProperties.birthDate,
      address: personProperties.address,
      email: personProperties.email,
      phone: personProperties.phone,
      // Required, unlike the driver's: it is one of the two ways he signs in.
      password: { type: 'string', minLength: 6, maxLength: 72 },
      acceptedPrivacy: { type: 'boolean' },
    },
  },
  response: { 201: authResponse[200] },
} as const;

export const clientProfileSchema = {
  response: { 200: clientPublicSchema },
} as const;

export const clientUpdateSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      firstName: personProperties.firstName,
      middleName: personProperties.middleName,
      lastName: personProperties.lastName,
      secondLastName: personProperties.secondLastName,
      birthDate: personProperties.birthDate,
      address: personProperties.address,
      email: personProperties.email,
      phone: personProperties.phone,
      password: { type: 'string', minLength: 6, maxLength: 72 },
      // Required by the service whenever `password` travels: a stolen session
      // must not be enough to lock the owner out of his own account.
      currentPassword: { type: 'string', minLength: 1, maxLength: 72 },
    },
  },
  response: { 200: clientPublicSchema },
} as const;

export const clientPhotoSchema = {
  response: {
    200: {
      type: 'object',
      properties: { photoUrl: { type: ['string', 'null'] } },
    },
  },
} as const;
