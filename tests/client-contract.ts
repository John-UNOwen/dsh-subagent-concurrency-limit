/**
 * Type-only contract for client/index.js, which is hand-written JavaScript
 * outside the main typecheck. Each line names an upstream export, member or
 * slot the client relies on, so a rename upstream fails `pnpm run typecheck`
 * instead of blanking the settings page. Never run; checked by
 * tsconfig.contract.json.
 */
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SettingsForm, SettingsFormModel, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ConfigForm, ConfigFormSnapshot, ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'

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

/** The pause control's calls on the pause row's form. */
export type PauseForm = [
  Has<ConfigForm<unknown>, 'getSnapshot'>,
  Has<ConfigForm<unknown>, 'subscribe'>,
  Has<ConfigForm<unknown>, 'set'>,
  Has<ConfigFormSnapshot<unknown>, 'status'>,
  Has<ConfigFormSnapshot<unknown>, 'mode'>,
  Has<ConfigFormSnapshot<unknown>, 'writable'>,
  Has<ConfigFormSnapshot<unknown>, 'value'>,
]

/** The settings form's Save and override markers read these from the form. */
export type SaveForm = [
  Has<ConfigForm<unknown>, 'mutate'>,
  Has<ConfigFormSnapshot<unknown>, 'revision'>,
  Has<ConfigFormSnapshot<unknown>, 'user'>,
  Has<ConfigFormSnapshot<unknown>, 'base'>,
]

/** The workspace route goes through `ctx.connection.rpc.call`. */
export type Rpc = Has<ClientConnectionRpc, 'call'>

/** The card reads `props.view` and renders only 'summary' or a page. */
export type View = Has<{ summary: 0; page: 0 }, PluginConfigViewProps['view']>
