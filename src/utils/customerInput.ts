// Shared customer-input contract: keep Backend and Storefront copies identical.
export const customerLimits = { firstName: 80, lastName: 80, recipientName: 160, line1: 200, line2: 200, city: 100, county: 100, postcode: 8, phone: 32 } as const;
export function normalizePostcode(value: string): string {
 const compact=value.replace(/\s/g,'').toUpperCase();
 return compact.length>3?compact.slice(0,-3)+' '+compact.slice(-3):compact;
}
export function validPostcode(value: string): boolean { return /^(?:GIR0AA|[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2})$/.test(value.replace(/\s/g,'').toUpperCase()); }
export function validPhone(value: string): boolean { return !value.trim() || /^(?:0|\+44|0044)[0-9]{9,10}$/.test(value.replace(/[\s().-]/g,'')); }
export function customerAddressError(value: {recipientName:string;line1:string;line2?:string|null;city:string;postcode:string;phone?:string|null}): string|null {
 for(const key of ['recipientName','line1','city','postcode'] as const)if(!value[key].trim())return key+' is required.';
 for(const key of ['recipientName','line1','line2','city','postcode','phone'] as const)if((key==='postcode'?normalizePostcode(value.postcode).length:value[key]?.trim().length??0)>customerLimits[key])return key+' is too long.';
 if(!validPostcode(value.postcode))return 'Enter a valid UK postcode.';
 if(!validPhone(value.phone??''))return 'Enter a valid UK phone number.';
 return null;
}
