/**
 * Type-only contract for client/index.js, which is hand-written JavaScript
 * outside the main typecheck. Each line names an upstream export, member or
 * slot the client relies on, so a rename upstream fails `pnpm run typecheck`
 * instead of blanking the settings page. Never run; checked by
 * tsconfig.contract.json.
 */
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SettingsForm, SettingsFormModel, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Fails to compile unless `T` has member `K`. */
type Has<T, K extends PropertyKey & ([K] extends [keyof T] ? unknown : never)> = K

/** UI components the card renders. */
export type Components = [typeof Switch, typeof SettingsForm, typeof SettingsValueField]

/** SettingsFormModel members the client calls. */
export type FormModel = [
  Has<SettingsFormModel<unknown>, 'bind'>,
  Has<SettingsFormModel<unknown>, 'shell'>,
  Has<SettingsFormModel<unknown>, 'field'>,
  Has<SettingsFormModel<unknown>, 'actions'>,
  Has<SettingsFormModel<unknown>, 'dispose'>,
]

/** `ctx.configForms` members the client calls. */
export type Forms = [Has<ConfigForms, 'get'>, Has<ConfigForms, 'whileServed'>]

/** The card reads `props.view` and renders only 'summary' or a page. */
export type View = Has<{ summary: 0; page: 0 }, PluginConfigViewProps['view']>
