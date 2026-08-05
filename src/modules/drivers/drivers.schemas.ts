/**
 * Shared JSON Schema building blocks for the driver registration/edit contracts.
 * Extracted so the admin routes (`drivers.routes.ts`) and the self-service app
 * registration (`driver-auth.routes.ts`) validate against the SAME rules.
 * Canonical formats are enforced at the edge; business rules (age, requirement
 * completeness, channel obligations) live in the services.
 */

/**
 * Optional payment details captured at cobro time (Pieza 2 + payer details
 * 2026-07-31). `reference` is a code: letters/digits/space, max 50. The payer
 * phone/id are only meaningful for Pago Móvil (validated client-side per
 * method); here they are just bounded, canonical-format strings.
 */
export const paymentMetaProps = {
  paymentMethodId: { type: ['integer', 'null'], minimum: 1 },
  reference: { type: ['string', 'null'], maxLength: 25, pattern: '^[\\p{L}\\p{N}]+(?: [\\p{L}\\p{N}]+)*$' },
  payerBank: { type: ['string', 'null'], maxLength: 120 },
  paidOn: { type: ['string', 'null'], format: 'date' },
  payerPhone: { type: ['string', 'null'], pattern: '^\\+58\\d{10}$' },
  payerId: { type: ['string', 'null'], pattern: '^[VEJ]-\\d{5,9}$' },
  // Email or name the payment came FROM (Zelle/Binance)
  payerAccount: { type: ['string', 'null'], maxLength: 100 },
} as const;

// Names: letters (incl. accents/ñ) with SINGLE space/hyphen/apostrophe
// separators between them — no digits/symbols, no doubled or edge separator
// ("Ana--", "-Ana"). Max 80. Kept in sync with the frontend `appLetters`.
const NAME_PATTERN = "^\\p{L}+(?:[ '-]\\p{L}+)*$";

// Vehicle text fields (kept in sync with the frontend directives): brand/model
// allow letters, digits, space and hyphen (real model names: "Mazda 3",
// "F-150"); color allows letters and space only. Shared by the 3 vehicle
// schemas (embedded in register, POST and PATCH /vehicles).
const BRAND_MODEL_PATTERN = '^[\\p{L}\\p{N}]+(?:[ -][\\p{L}\\p{N}]+)*$';
const COLOR_PATTERN = '^\\p{L}+(?: \\p{L}+)*$';
export const vehicleFieldProps = {
  vehicleTypeId: { type: ['integer', 'null'], minimum: 1 },
  brand: { type: ['string', 'null'], maxLength: 60, pattern: BRAND_MODEL_PATTERN },
  model: { type: ['string', 'null'], maxLength: 60, pattern: BRAND_MODEL_PATTERN },
  year: { type: ['integer', 'null'], minimum: 1900, maximum: 2100 },
  color: { type: ['string', 'null'], maxLength: 30, pattern: COLOR_PATTERN },
  plate: { type: ['string', 'null'], maxLength: 15 },
} as const;
export const personProperties = {
  firstName: { type: 'string', minLength: 2, maxLength: 80, pattern: NAME_PATTERN },
  middleName: { type: ['string', 'null'], maxLength: 80, pattern: NAME_PATTERN },
  lastName: { type: 'string', minLength: 2, maxLength: 80, pattern: NAME_PATTERN },
  secondLastName: { type: ['string', 'null'], maxLength: 80, pattern: NAME_PATTERN },
  birthDate: { type: ['string', 'null'], format: 'date' },
  address: { type: ['string', 'null'], maxLength: 500 },
  email: { type: ['string', 'null'], format: 'email' },
  phone: { type: ['string', 'null'], pattern: '^\\+58\\d{10}$' },
  // V = venezolano · E = extranjero · J = jurídico (RIF)
  nationalId: { type: ['string', 'null'], pattern: '^[VEJ]-\\d{5,9}$' },
  // Driver app password: min 6, digits-only allowed (PIN-like, decision
  // 2026-07-16). It guards the driver's app, not the admin panel.
  password: { type: ['string', 'null'], minLength: 6, maxLength: 72 },
} as const;

const documentItems = {
  type: 'array',
  maxItems: 30,
  items: {
    type: 'object',
    required: ['requirementId'],
    additionalProperties: false,
    properties: {
      requirementId: { type: 'integer', minimum: 1 },
      expiresAt: { type: ['string', 'null'], format: 'date' },
    },
  },
} as const;

export const createBody = {
  type: 'object',
  required: ['firstName', 'lastName'],
  additionalProperties: false,
  properties: personProperties,
} as const;

/**
 * Transactional registration (2026-07-21): personal data plus optional
 * vehicles, document metadata and a payment - all persisted in one transaction.
 * Document FILES are uploaded afterwards against the returned document ids.
 * Shared by the admin route and the app self-registration (which layers its own
 * stricter obligations in the service, per the channel rules).
 */
export const registerBody = {
  type: 'object',
  required: ['firstName', 'lastName'],
  additionalProperties: false,
  properties: {
    ...personProperties,
    payment: {
      type: ['object', 'null'],
      required: ['planId', 'periods'],
      additionalProperties: false,
      properties: {
        planId: { type: 'integer', minimum: 1 },
        periods: { type: 'integer', minimum: 1, maximum: 520 },
        ...paymentMetaProps,
      },
    },
    // v9 (2026-08-04): the alta is being paid up front via a pending `enroll`
    // submission (membership + N weeks, one invoice on approval). When true the
    // registration must NOT emit the base alta debt — the submission covers it.
    deferredEnrollment: { type: 'boolean' },
    vehicles: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...vehicleFieldProps,
          documents: documentItems,
        },
      },
    },
    documents: documentItems,
  },
} as const;
