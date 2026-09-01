import { personProperties } from '../drivers/drivers.schemas.js';

/**
 * Validation for the passenger side (proposal: docs/proposals/cliente).
 *
 * The person fields are the SAME ones the affiliate registration uses —
 * imported, not copied. Since 2026-09-01 each role owns its OWN email, phone
 * and password (independent roles, decision by Luis); what both share is the
 * person: names, cédula and birth date.
 */

/** App password policy (both roles): digits only, 6 to 8 (Luis, 2026-09-01). */
const appPassword = { type: 'string', pattern: '^\\d{6,8}$' } as const;

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
     * The office-verified one (`drivers`) when the person is also an
     * affiliate, else the self-declared one (`clients`). Null only on legacy
     * accounts registered before the cédula became mandatory (2026-08-31).
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
      // Lenient on purpose: passwords predating the numeric policy still work.
      password: { type: 'string', minLength: 1, maxLength: 72 },
    },
  },
  response: authResponse,
} as const;

/**
 * Step 0 of both registrations (Luis, 2026-09-01): the cédula travels FIRST
 * and the answer says which form to show. `new` = nobody has it (full form);
 * `attachable` = the person exists without a client side (short form);
 * `exists` = already a client (go log in).
 */
export const clientCheckCedulaSchema = {
  body: {
    type: 'object',
    required: ['nationalId'],
    additionalProperties: false,
    properties: { nationalId: personProperties.nationalId },
  },
  response: {
    200: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['new', 'attachable', 'exists'] } },
    },
  },
} as const;

export const clientRegisterSchema = {
  body: {
    type: 'object',
    // Parity with the affiliate registration (decision by Luis, 2026-08-31):
    // everything mandatory except middle name, second last name and address.
    required: [
      'firstName',
      'lastName',
      'birthDate',
      'nationalId',
      'phone',
      'email',
      'password',
      'acceptedPrivacy',
    ],
    additionalProperties: false,
    properties: {
      firstName: personProperties.firstName,
      middleName: personProperties.middleName,
      lastName: personProperties.lastName,
      secondLastName: personProperties.secondLastName,
      birthDate: personProperties.birthDate,
      nationalId: personProperties.nationalId,
      address: personProperties.address,
      email: personProperties.email,
      phone: personProperties.phone,
      password: appPassword,
      acceptedPrivacy: { type: 'boolean' },
    },
  },
  response: { 201: authResponse[200] },
} as const;

/**
 * The SHORT form (Luis, 2026-09-01): an existing person — usually an
 * affiliate — gains the client side. He proves it is him with the password he
 * already has, and types only what is HIS as a client: email, phone and this
 * role's password (same or different, his call). Names, cédula and birth date
 * are the person's and are neither asked nor shown.
 */
export const clientAttachSchema = {
  body: {
    type: 'object',
    required: ['nationalId', 'currentPassword', 'email', 'phone', 'password', 'acceptedPrivacy'],
    additionalProperties: false,
    properties: {
      nationalId: personProperties.nationalId,
      // Lenient: the proof is whatever password the account already has.
      currentPassword: { type: 'string', minLength: 1, maxLength: 72 },
      email: personProperties.email,
      phone: personProperties.phone,
      password: appPassword,
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
      // Names and address are the PERSON's (shared with the driver side).
      firstName: personProperties.firstName,
      middleName: personProperties.middleName,
      lastName: personProperties.lastName,
      secondLastName: personProperties.secondLastName,
      birthDate: personProperties.birthDate,
      address: personProperties.address,
      // Email, phone and password are THIS role's own.
      email: personProperties.email,
      phone: personProperties.phone,
      password: appPassword,
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
