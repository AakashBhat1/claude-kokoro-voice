/** `reply`: the whole final reply, code stripped. `last`: only its last paragraph. */
export type VoiceMode = 'reply' | 'last'

export type VoiceSettings = { isOn: boolean; mode: VoiceMode }

declare module 'claude-code' {
  interface PluginState {
    'kokoro-voice': { settings: Shaped<VoiceSettings> }
  }
}
