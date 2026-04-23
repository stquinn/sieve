import React, { useState, useEffect } from 'react'
import { BaseModal } from './Modal'
import { StorableDataService } from '../lib/StorableDataService'
import { main } from '../../wailsjs/go/models'
import { getModKey } from '../utils/platform'
import { ChevronDown } from 'lucide-react'

interface Props {
  onClose: () => void
  dataService: StorableDataService
  onSettingsChanged: () => void
}

type Tab = 'ai' | 'appearance' | 'editor'

export function SettingsModal({ onClose, dataService, onSettingsChanged }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('ai')
  const [settings, setSettings] = useState<any>(null)
  const [isSaving, setIsSaving] = useState(false)
  const mod = getModKey()

  useEffect(() => {
    loadSettings()
  }, [])

  async function loadSettings() {
    const info = await dataService.getStoreInfo()
    setSettings({
      cli: info.cli,
      model: '', // Backend doesn't currently expose the exact model name in StoreInfo easily, but we can add it
      autosave_debounce: info.autosaveDebounce,
      theme: info.themeName,
      max_history_versions: info.maxHistoryVersions,
      cli_timeout_long: info.cliTimeoutLong,
      debug: info.debug,
    })
  }

  async function handleSave() {
    setIsSaving(true)
    try {
      await dataService.saveSettings(settings)
      onSettingsChanged()
      onClose()
    } catch (err) {
      console.error('Failed to save settings:', err)
    } finally {
      setIsSaving(false)
    }
  }

  if (!settings) return null

  return (
    <BaseModal onClose={onClose} className="max-w-2xl">
      <div className="flex h-[450px]">
        {/* Sidebar */}
        <div className="w-48 bg-tn-bg-dark border-t border-r border-solid border-tn-border-2 p-4 flex flex-col gap-2">
          <h2 className="text-xs font-bold text-tn-muted uppercase tracking-widest mb-4 px-2">Settings</h2>
          <TabButton 
            active={activeTab === 'ai'} 
            onClick={() => setActiveTab('ai')}
            label="AI Provider"
          />
          <TabButton 
            active={activeTab === 'appearance'} 
            onClick={() => setActiveTab('appearance')}
            label="Appearance"
          />
          <TabButton 
            active={activeTab === 'editor'} 
            onClick={() => setActiveTab('editor')}
            label="Editor"
          />
        </div>

        {/* Content */}
        <div className="flex-1 bg-tn-bg-dark border-t border-solid border-tn-border-2 p-8 overflow-y-auto">
          {activeTab === 'ai' && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold text-tn-text">AI Configuration</h3>
              <Field label="AI Provider (CLI)">
                <select 
                  value={settings.cli}
                  onChange={e => setSettings({ ...settings, cli: e.target.value })}
                  className="w-full bg-tn-bg border border-solid border-tn-border-2 rounded-lg px-4 py-2.5 text-tn-text focus:outline-none focus:border-tn-blue appearance-none cursor-pointer"
                >
                  <option value="claude">Claude</option>
                  <option value="gemini">Gemini</option>
                  <option value="copilot">Copilot</option>
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-tn-muted">
                  <ChevronDown className="w-4 h-4" />
                </div>
                <p className="mt-2 text-[11px] text-tn-muted px-1">The CLI tool used for AI operations.</p>
              </Field>

              <Field label="Model Override (Optional)">
                <input 
                  type="text"
                  placeholder="e.g. claude-3-5-sonnet"
                  value={settings.model}
                  onChange={e => setSettings({ ...settings, model: e.target.value })}
                  className="w-full bg-tn-bg border border-solid border-tn-border-2 rounded-lg px-4 py-2.5 text-tn-text focus:outline-none focus:border-tn-blue placeholder:text-tn-muted/50"
                />
              </Field>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold text-tn-text">Appearance</h3>
              <Field label="Theme">
                <select 
                  value={settings.theme}
                  onChange={e => setSettings({ ...settings, theme: e.target.value })}
                  className="w-full bg-tn-bg border border-solid border-tn-border-2 rounded-lg px-4 py-2.5 text-tn-text focus:outline-none focus:border-tn-blue appearance-none cursor-pointer"
                >
                  <option value="tokyonight">Tokyo Night</option>
                  <option value="sublime">Sublime</option>
                  <option value="nord">Nord</option>
                  <option value="solarized">Solarized Dark</option>
                  <option value="vscode">VS Code Dark+</option>
                  <option value="darcula">IntelliJ Darcula</option>
                  <option value="onedark">One Dark</option>
                  <option value="monokai">Monokai Pro</option>
                  <option value="gruvbox">Gruvbox Dark</option>
                  <option value="catppuccin">Catppuccin Macchiato</option>
                  <option value="stardust">Stardust (Neon)</option>
                  <option value="emerald">Emerald City</option>
                  <option value="synthwave">SynthWave '84</option>
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-tn-muted">
                  <ChevronDown className="w-4 h-4" />
                </div>
              </Field>
            </div>
          )}

          {activeTab === 'editor' && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold text-tn-text">Editor & History</h3>
              <Field label="Autosave Delay (seconds)">
                <input 
                  type="number"
                  value={settings.autosave_debounce}
                  onChange={e => setSettings({ ...settings, autosave_debounce: parseInt(e.target.value) })}
                  className="w-full bg-tn-bg border border-solid border-tn-border-2 rounded-lg px-4 py-2.5 text-tn-text focus:outline-none focus:border-tn-blue"
                />
              </Field>

              <Field label="Max History Versions">
                <input 
                  type="number"
                  value={settings.max_history_versions}
                  onChange={e => setSettings({ ...settings, max_history_versions: parseInt(e.target.value) })}
                  className="w-full bg-tn-bg border border-solid border-tn-border-2 rounded-lg px-4 py-2.5 text-tn-text focus:outline-none focus:border-tn-blue"
                />
              </Field>

              <div className="flex items-center gap-3 pt-4">
                <input 
                  type="checkbox"
                  id="debug-mode"
                  checked={settings.debug}
                  onChange={e => setSettings({ ...settings, debug: e.target.checked })}
                  className="w-4 h-4 rounded border-tn-border-2 bg-tn-bg text-tn-blue focus:ring-tn-blue"
                />
                <label htmlFor="debug-mode" className="text-sm text-tn-text">Enable Debug Mode</label>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="bg-tn-bg-alt px-8 py-4 flex justify-end gap-3 border-t border-solid border-tn-border-2">
        <button 
          onClick={onClose}
          className="px-6 py-2 text-sm font-medium text-tn-text-dim hover:text-tn-text transition-colors bg-transparent border-none cursor-pointer"
        >
          Cancel
        </button>
        <button 
          onClick={handleSave}
          disabled={isSaving}
          className="px-6 py-2 text-sm font-bold text-white bg-tn-blue hover:bg-tn-blue-brighter rounded-lg transition-all shadow-lg shadow-tn-blue/20 disabled:opacity-50 border-none cursor-pointer"
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </BaseModal>
  )
}

function TabButton({ active, onClick, label }: { active: boolean, onClick: () => void, label: string }) {
  return (
    <button
      onClick={onClick}
      className={`text-left px-4 py-2.5 rounded-lg text-sm font-semibold transition-all border-none cursor-pointer relative ${
        active 
          ? 'bg-tn-bg-alt text-tn-blue shadow-sm' 
          : 'bg-transparent text-tn-text-dim hover:bg-tn-bg-alt/50 hover:text-tn-text'
      }`}
    >
      {label}
    </button>
  )
}

function Field({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <label className="text-xs font-bold text-tn-muted uppercase tracking-wider px-1">{label}</label>
      <div className="relative">
        {children}
      </div>
    </div>
  )
}
