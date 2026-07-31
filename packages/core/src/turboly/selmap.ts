/**
 * Turboly Service Order — SELECTOR MAP.
 *
 * This is the ONLY file that encodes Turboly's DOM. Everything else is generic.
 * Built from screenshots of sandbox.turboly.com (2026-07-31, tenant "VICTOR - NAWILIS").
 *
 * Strategy (per the design brief): prefer accessible/label/placeholder locators
 * over brittle CSS paths, so a Turboly restyle doesn't break us. Where Turboly
 * uses custom typeahead dropdowns (not native <select>), we model them as
 * {trigger, search, option} and drive them by open→type→pick.
 *
 * ⚠️  CONFIRM ONCE against sandbox with `npm run capture:turboly`. That tool
 *     opens the live form, verifies each locator resolves, and reports any that
 *     need adjustment. Do not run the RPA against production until it's green.
 *
 * Known from screenshots:
 *   - Base tenant host:      https://sandbox.turboly.com  (prod host TBD — set in env)
 *   - Sales menu:            /welcome/sales
 *   - Service Orders list:   /service_orders   (filters incl. Registration, Store, Document Number, Status)
 *   - New Service Order:     list → "+ New Service Order"
 *   - Workflow states:       DRAFT → APPROVED
 *   - Required header fields (marked * on the form): STORE, CUSTOMER, VEHICLE,
 *     PLAN SERVICE DATE, PLAN SERVICE TIME, SERVICE ADVISOR, SALESPERSON, ODOMETER
 *   - Line items under tab "Packages, Spareparts & Services" → "Services"
 *     ("+ Add Service Item": Service, Description, Estimated Time, Qty, Tax=PPN, Price Inc Tax, Discount)
 */

export type LocatorKind = 'role' | 'label' | 'placeholder' | 'text' | 'css';

export interface Loc {
  kind: LocatorKind;
  value: string;
  /** For role locators, the accessible name. */
  name?: string;
  /** Optional note for the capture tool / maintainer. */
  note?: string;
}

/** A custom typeahead dropdown: open it, type into search, click the matching option. */
export interface Typeahead {
  trigger: Loc;
  search: Loc;
  /** Option template — `{q}` is replaced with the search text at runtime. */
  optionByText: (text: string) => Loc;
}

export interface TurbolySelectorMap {
  version: string;
  routes: {
    login: string;
    salesMenu: string;
    serviceOrdersList: string;
    newServiceOrderButton: Loc;
  };
  login: {
    username: Loc;
    password: Loc;
    submit: Loc;
    /** A locator that only exists when logged in (session check). */
    loggedInMarker: Loc;
    /** A locator that only exists when a login/OTP challenge is present. */
    otpField?: Loc;
  };
  header: {
    documentNumber: Loc; // usually read-only / auto
    type: Typeahead;
    store: Typeahead; // *required
    customerSearch: Typeahead; // *required
    addNewCustomerButton: Loc;
    vehicleRegistrationSearch: Typeahead; // *required
    contactPersons: Loc;
    planServiceDate: Loc; // *required
    planServiceTime: Loc; // *required
    serviceAdvisor: Typeahead; // *required
    salesperson: Typeahead; // *required
    bookingSource: Typeahead;
    referenceNumber: Loc; // ← correlation token goes here
    promoCode: Loc;
    odometer: Loc; // *required
    notes: Loc;
  };
  /** New-customer sub-form (opened by addNewCustomerButton). */
  newCustomer: {
    nama: Loc;
    phone: Loc;
    alamat: Loc;
    save: Loc;
  };
  tabs: {
    inspections: Loc;
    packagesSparepartsServices: Loc;
    subletSundry: Loc;
  };
  services: {
    addServiceItem: Loc;
    /** Within the newest service row: */
    rowService: Typeahead;
    rowDescription: Loc;
    rowQty: Loc;
    rowPriceIncTax: Loc;
    rowDiscount: Loc;
    /** Delete the newest row (for rollback on partial failure). */
    rowDelete: Loc;
  };
  spareparts: {
    addSparepart: Loc;
    rowProduct: Typeahead;
    rowQty: Loc;
    rowPriceIncTax: Loc;
  };
  actions: {
    save: Loc;
    cancel: Loc;
    /** Workflow advance DRAFT→APPROVED (button/label TBD — confirm in capture). */
    approve: Loc;
  };
  /** After save, where Turboly's generated document number appears. */
  savedDocNumber: Loc;
  /** Service Orders LIST — for read-back verification. */
  list: {
    documentNumberFilter: Loc;
    registrationFilter: Loc;
    storeFilter: Typeahead;
    fromDate: Loc;
    toDate: Loc;
    searchButton: Loc;
    /** A result row locator, given a document number. */
    rowByDocNo: (docNo: string) => Loc;
    /** A result row locator, given a registration/plate. */
    rowByRegistration: (plate: string) => Loc;
  };
}

const role = (r: string, name?: string, note?: string): Loc => ({ kind: 'role', value: r, name, note });
const label = (value: string, note?: string): Loc => ({ kind: 'label', value, note });
const ph = (value: string, note?: string): Loc => ({ kind: 'placeholder', value, note });
const text = (value: string, note?: string): Loc => ({ kind: 'text', value, note });
const css = (value: string, note?: string): Loc => ({ kind: 'css', value, note });

/**
 * The map. Placeholders/labels are taken verbatim from the screenshots.
 * `note: 'CONFIRM'` marks locators most likely to need a tweak after capture
 * (custom dropdown internals, the DRAFT→APPROVED control, the saved-docno spot).
 */
export const SELECTOR_MAP: TurbolySelectorMap = {
  version: '2026-07-31-sandbox',
  routes: {
    login: '/login',
    salesMenu: '/welcome/sales',
    serviceOrdersList: '/service_orders',
    newServiceOrderButton: role('button', 'New Service Order'),
  },
  login: {
    username: ph('Email', 'CONFIRM — could be Email/Username'),
    password: ph('Password'),
    submit: role('button', 'Login', 'CONFIRM — could be Sign In'),
    loggedInMarker: text('Dashboard'),
    otpField: ph('OTP', 'only present if 2FA enabled'),
  },
  header: {
    documentNumber: label('DOCUMENT NUMBER'),
    type: {
      trigger: ph('General', 'TYPE dropdown, defaults to General'),
      search: css('.select2-search__field', 'CONFIRM dropdown widget'),
      optionByText: (t) => text(t),
    },
    store: {
      trigger: ph('Select Store'),
      search: css('.select2-search__field'),
      optionByText: (t) => text(t),
    },
    customerSearch: {
      trigger: ph('Search Name/Phone'),
      search: ph('Search Name/Phone'),
      optionByText: (t) => text(t),
    },
    addNewCustomerButton: role('button', 'Add New Customer'),
    vehicleRegistrationSearch: {
      trigger: ph('Search Registration'),
      search: ph('Search Registration'),
      optionByText: (t) => text(t),
    },
    contactPersons: ph('Select Contact Person'),
    planServiceDate: ph('Service Date'),
    planServiceTime: ph('Service Time'),
    serviceAdvisor: {
      trigger: ph('Service Advisor'),
      search: css('.select2-search__field'),
      optionByText: (t) => text(t),
    },
    salesperson: {
      trigger: ph('Salesperson'),
      search: css('.select2-search__field'),
      optionByText: (t) => text(t),
    },
    bookingSource: {
      trigger: ph('Booking Source'),
      search: css('.select2-search__field'),
      optionByText: (t) => text(t),
    },
    referenceNumber: label('REFERENCE NUMBER', 'CONFIRM — may have no placeholder; locate by label'),
    promoCode: ph('Promo Code'),
    odometer: label('ODOMETER'),
    notes: css('textarea', 'CONFIRM — the Notes textarea under the "Notes" heading'),
  },
  newCustomer: {
    nama: label('Name', 'CONFIRM new-customer modal fields'),
    phone: label('Phone'),
    alamat: label('Address'),
    save: role('button', 'Save'),
  },
  tabs: {
    inspections: role('tab', 'Inspections'),
    packagesSparepartsServices: role('tab', 'Packages, Spareparts & Services'),
    subletSundry: role('tab', 'Sublet & Sundry'),
  },
  services: {
    addServiceItem: role('button', 'Add Service Item'),
    rowService: {
      trigger: ph('Service', 'CONFIRM — per-row service typeahead'),
      search: css('.select2-search__field'),
      optionByText: (t) => text(t),
    },
    rowDescription: ph('Description'),
    rowQty: css('input[name*="quantity"]', 'CONFIRM per-row qty input'),
    rowPriceIncTax: css('input[name*="price"]', 'CONFIRM per-row price input'),
    rowDiscount: css('input[name*="discount"]', 'CONFIRM per-row discount'),
    rowDelete: role('button', 'Delete'),
  },
  spareparts: {
    addSparepart: role('button', 'Add Sparepart'),
    rowProduct: {
      trigger: ph('Product'),
      search: css('.select2-search__field'),
      optionByText: (t) => text(t),
    },
    rowQty: css('input[name*="quantity"]'),
    rowPriceIncTax: css('input[name*="price"]'),
  },
  actions: {
    save: role('button', 'Save'),
    cancel: role('button', 'Cancel'),
    approve: role('button', 'Approved', 'CONFIRM — the DRAFT→APPROVED workflow control'),
  },
  savedDocNumber: label('DOCUMENT NUMBER', 'CONFIRM — where the generated SBO/.../... number renders after save'),
  list: {
    documentNumberFilter: ph('Document Number'),
    registrationFilter: ph('Registration'),
    storeFilter: {
      trigger: ph('Store'),
      search: css('.select2-search__field'),
      optionByText: (t) => text(t),
    },
    fromDate: ph('From Date'),
    toDate: ph('To Date'),
    searchButton: role('button', 'Search'),
    rowByDocNo: (docNo) => text(docNo),
    rowByRegistration: (plate) => text(plate),
  },
};
