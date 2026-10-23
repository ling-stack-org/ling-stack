declare const bindingBrand: unique symbol;

/** Opaque startup binding identity; runtime custody remains in the Host bridge. */
export interface DelegationHostStoreBinding { readonly [bindingBrand]: true }
