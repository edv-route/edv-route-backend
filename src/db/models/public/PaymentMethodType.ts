/** Represents the enum public.payment_method_type */
type PaymentMethodType = 
  | 'bank_transfer'
  | 'pago_movil'
  | 'zelle'
  | 'paypal'
  | 'binance'
  | 'crypto'
  | 'contact';

export type { PaymentMethodType as default };