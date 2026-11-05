/**
 * Configuration schema.
 *
 * Two shapes exist on purpose:
 *  - a *patch* shape where everything except `id` is optional, because a
 *    workspace file is allowed to override one field of a system;
 *  - an *effective* shape that is validated after merging, where endpoint and
 *    credentials must be present.
 *
 * Validating each layer against the patch shape means a typo is reported with
 * the layer name and field path instead of being silently dropped.
 */

import { z } from "zod";

/** Lower number = stricter. Merging always keeps the stricter tier. */
export const TIER_ORDER = { prd: 0, qa: 1, dev: 2 } as const;

export type Tier = keyof typeof TIER_ORDER;

export const TierSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .refine((value): value is Tier => value in TIER_ORDER, {
    message: "tier must be one of: dev, qa, prd",
  });

/**
 * Credentials are never written in the config file. Only these three reference
 * forms are accepted; anything else is treated as a plain-text secret.
 */
export const SecretRefSchema = z.string().refine(
  (value) => /^(env|keychain|file):\S+$/.test(value),
  {
    message:
      'must be a reference: "env:NAME", "keychain:service/account" or "file:~/.secrets/name" — plain-text secrets are rejected',
  },
);

const ClientSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^\d{3}$/.test(value), { message: "client must be three digits, e.g. 400" });

const LanguageSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9]{1,2}$/.test(value), {
    message: "language must be a one- or two-character SAP language code, e.g. E or ZH",
  });

const LogLevelSchema = z.enum(["error", "warn", "info", "debug"]);

const EndpointSchema = z.object({
  url: z.string().url(),
  client: ClientSchema,
  language: LanguageSchema.optional(),
  systemType: z.enum(["onprem", "cloud"]).optional(),
});

const AuthSchema = z.object({
  type: z.literal("basic").default("basic"),
  username: SecretRefSchema,
  password: SecretRefSchema,
});

const SystemCommon = {
  label: z.string().optional(),
  tier: TierSchema.optional(),
  endpoint: EndpointSchema.partial().optional(),
  auth: AuthSchema.partial().optional(),
  rfcBackend: z.enum(["soap", "odata"]).optional(),
  env: z.record(z.string()).optional(),
};

/** One system as written in a single layer: only `id` is required. */
export const SystemPatchSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, "system id must be lowercase alphanumeric with . _ -"),
  ...SystemCommon,
});

/** One system after merging: it must be complete enough to connect. */
export const SystemSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  tier: TierSchema,
  endpoint: z.object({
    url: z.string().url(),
    client: ClientSchema,
    language: LanguageSchema.default("EN"),
    systemType: z.enum(["onprem", "cloud"]).default("onprem"),
  }),
  auth: z.object({
    type: z.literal("basic").default("basic"),
    username: SecretRefSchema,
    password: SecretRefSchema,
  }),
  rfcBackend: z.enum(["soap", "odata"]).default("soap"),
  env: z.record(z.string()).default({}),
});

/** A configuration layer. Every field is optional: layers override, they do not restate. */
export const ConfigPatchSchema = z.object({
  $schema: z.string().optional(),
  server: z
    .object({
      name: z.string().optional(),
      logLevel: LogLevelSchema.optional(),
    })
    .optional(),
  defaultSystem: z.string().optional(),
  toolPolicy: z
    .object({
      timeoutMs: z.number().int().positive().optional(),
      layers: z.array(z.enum(["readonly", "write", "low"])).optional(),
      allow: z.array(z.string().min(1)).optional(),
      deny: z.array(z.string().min(1)).optional(),
      gateway: z.boolean().optional(),
    })
    .optional(),
  systems: z.array(SystemPatchSchema).optional(),
});

/** The merged, fully resolved configuration. */
export const EffectiveConfigSchema = z.object({
  server: z.object({
    name: z.string(),
    logLevel: LogLevelSchema,
  }),
  defaultSystem: z.string().optional(),
  toolPolicy: z.object({
    timeoutMs: z.number().int().positive(),
    layers: z.array(z.enum(["readonly", "write", "low"])),
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    gateway: z.boolean(),
  }),
  systems: z.array(SystemSchema),
});

export type ConfigPatch = z.input<typeof ConfigPatchSchema>;
export type SystemPatch = z.input<typeof SystemPatchSchema>;
export type EffectiveConfig = z.output<typeof EffectiveConfigSchema>;
export type EffectiveSystem = z.output<typeof SystemSchema>;
