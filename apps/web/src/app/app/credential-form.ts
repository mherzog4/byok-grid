export interface DeclarativeCredentialField {
  description: string;
  key: string;
  label: string;
  placeholder?: string;
  required: boolean;
  secret: boolean;
}

export function readDeclarativeCredential(
  fields: readonly DeclarativeCredentialField[],
  data: FormData
): Record<string, string> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = String(data.get(`credential:${field.key}`) ?? '');
      return !field.required && value === ''
        ? []
        : [[field.key, value] as const];
    })
  );
}
