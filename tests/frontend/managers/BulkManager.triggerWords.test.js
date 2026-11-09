import { describe, it, beforeEach, expect, vi } from 'vitest';
import { renderTemplate } from '../utils/domFixtures.js';

const showToastMock = vi.fn();
const translateMock = vi.fn((key, params, fallback) => (typeof fallback === 'string' ? fallback : key));

const loadingManagerStub = {
  showSimpleLoading: vi.fn(),
  showCancelButton: vi.fn(),
  hide: vi.fn(),
};

const stateStub = {
  currentPageType: 'loras',
  bulkMode: false,
  selectedModels: new Set(),
  loadingManager: loadingManagerStub,
  virtualScroller: { updateSingleItem: vi.fn() },
  global: { settings: {} },
};

const saveModelMetadataMock = vi.fn();
const getModelApiClientMock = vi.fn(() => ({ saveModelMetadata: saveModelMetadataMock }));
const updateRecipeMetadataMock = vi.fn(() => Promise.resolve({ success: true }));
const showModalMock = vi.fn();
const closeModalMock = vi.fn();

vi.mock('../../../static/js/state/index.js', () => ({
  state: stateStub,
  getCurrentPageState: vi.fn(),
}));

vi.mock('../../../static/js/utils/uiHelpers.js', () => ({
  showToast: showToastMock,
  copyToClipboard: vi.fn(),
  sendLoraToWorkflow: vi.fn(),
  sendEmbeddingToWorkflow: vi.fn(),
  buildLoraSyntax: vi.fn(),
  getNSFWLevelName: vi.fn(() => 'Unknown'),
}));

vi.mock('../../../static/js/api/modelApiFactory.js', () => ({
  getModelApiClient: getModelApiClientMock,
  resetAndReload: vi.fn(),
}));

vi.mock('../../../static/js/api/recipeApi.js', () => ({
  RecipeSidebarApiClient: class {},
  updateRecipeMetadata: updateRecipeMetadataMock,
  extractRecipeId: vi.fn(),
}));

vi.mock('../../../static/js/api/apiConfig.js', () => ({
  MODEL_TYPES: { LORA: 'loras', CHECKPOINT: 'checkpoints', EMBEDDING: 'embeddings' },
  MODEL_CONFIG: {},
}));

vi.mock('../../../static/js/managers/ModalManager.js', () => ({
  modalManager: { showModal: showModalMock, closeModal: closeModalMock },
}));

vi.mock('../../../static/js/components/shared/ModelCard.js', () => ({
  updateCardsForBulkMode: vi.fn(),
}));

vi.mock('../../../static/js/utils/i18nHelpers.js', () => ({
  translate: translateMock,
  updateElementText: vi.fn(),
}));

vi.mock('../../../static/js/utils/priorityTagHelpers.js', () => ({
  getPriorityTagSuggestions: vi.fn(),
}));

vi.mock('../../../static/js/components/shared/NsfwLevelSelector.js', () => ({
  getNsfwLevelSelector: vi.fn(),
}));


describe('BulkManager bulk trigger words', () => {
  let bulk;
  beforeEach(async () => {
    vi.resetAllMocks();
    stateStub.currentPageType = 'loras';
    stateStub.selectedModels = new Set(['/models/a.safetensors', '/models/b.safetensors']);
    stateStub.bulkMode = false;
    getModelApiClientMock.mockReturnValue({ saveModelMetadata: saveModelMetadataMock });
    saveModelMetadataMock.mockResolvedValue({ success: true });
    translateMock.mockImplementation((key) => key);
    renderTemplate('components/modals/bulk_trigger_words_modal.html');
    const { BulkManager } = await import('../../../static/js/managers/BulkManager.js');
    bulk = new BulkManager();
    closeModalMock.mockImplementation(() => showModalMock.mock.calls.at(-1)?.[3]?.());
  });

  function enterWords(value) {
    bulk.showBulkTriggerWordsModal();
    document.getElementById('bulkTriggerWordsInput').value = value;
  }

  it('opens for selected LoRAs and resets the previous input', () => {
    enterWords('old input');
    bulk.showBulkTriggerWordsModal();
    expect(showModalMock).toHaveBeenCalledWith('bulkTriggerWordsModal', null, null, expect.any(Function));
    expect(translateMock).toHaveBeenCalledWith('modals.bulkTriggerWords.description', { count: 2 });
    expect(document.getElementById('bulkTriggerWordsInput').value).toBe('');
    expect(document.activeElement.id).toBe('bulkTriggerWordsInput');
  });

  it('registers the template with the real modal manager and closes cleanly', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const { ModalManager } = await vi.importActual('../../../static/js/managers/ModalManager.js');
    const manager = new ModalManager();
    manager.initialize();
    showModalMock.mockImplementation((...args) => manager.showModal(...args));
    bulk.showBulkTriggerWordsModal();
    expect(document.getElementById('bulkTriggerWordsModal').style.display).toBe('block');
    manager.closeModal('bulkTriggerWordsModal');
    expect(document.getElementById('bulkTriggerWordsModal').style.display).toBe('none');
    expect(bulk.bulkTriggerWordsPaths).toBeNull();
    document.removeEventListener('keydown', manager.boundHandleEscape);
    scrollTo.mockRestore();
  });

  it('connects the bulk menu action and hides it outside the LoRA page', async () => {
    const { bulkManager } = await import('../../../static/js/managers/BulkManager.js');
    const { BulkContextMenu } = await import('../../../static/js/components/ContextMenu/BulkContextMenu.js');
    renderTemplate('components/context_menu.html');
    const menu = new BulkContextMenu();
    const item = menu.menu.querySelector('[data-action="set-trigger-words"]');
    expect(item.style.display).toBe('flex');
    const open = vi.spyOn(bulkManager, 'showBulkTriggerWordsModal').mockImplementation(() => {});
    menu.currentCard = document.createElement('div');
    item.click();
    expect(open).toHaveBeenCalledOnce();
    stateStub.currentPageType = 'checkpoints';
    menu.updateMenuItemsForModelType();
    expect(item.style.display).toBe('none');
    open.mockRestore();
  });

  it('saves the selection captured when opening, including unrendered cards', async () => {
    enterWords('  Soleil style  \r\nred dress, white lace\n\nSoleil style\n');
    stateStub.selectedModels = new Set(['/models/unselected.safetensors']);
    await bulk.saveBulkTriggerWords();
    expect(saveModelMetadataMock.mock.calls).toEqual([
      ['/models/a.safetensors', { civitai: { trainedWords: ['Soleil style', 'red dress, white lace'] } }],
      ['/models/b.safetensors', { civitai: { trainedWords: ['Soleil style', 'red dress, white lace'] } }],
    ]);
    expect(showToastMock).toHaveBeenCalledWith('toast.models.bulkTriggerWordsSuccess', { count: 2 }, 'success');
    expect(bulk.bulkTriggerWordsPaths).toBeNull();
  });

  it('continues after a failed model and reports both counts', async () => {
    enterWords('style');
    saveModelMetadataMock.mockRejectedValueOnce(new Error('write failed'));
    await bulk.saveBulkTriggerWords();
    expect(saveModelMetadataMock).toHaveBeenCalledTimes(2);
    expect(showToastMock).toHaveBeenCalledWith('toast.models.bulkTriggerWordsSuccess', { count: 1 }, 'success');
    expect(showToastMock).toHaveBeenCalledWith('toast.models.bulkTriggerWordsFailed', { count: 1 }, 'error');
    expect(bulk.savingBulkTriggerWords).toBe(false);
  });

  it('does not submit twice while a save is pending', async () => {
    enterWords('style');
    let finish;
    saveModelMetadataMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = bulk.saveBulkTriggerWords();
    await bulk.saveBulkTriggerWords();
    expect(saveModelMetadataMock).toHaveBeenCalledTimes(1);
    finish({ success: true });
    await pending;
    expect(saveModelMetadataMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [' \n ', 'toast.models.bulkTriggerWordsEmpty'],
    [Array.from({ length: 101 }, (_, i) => `word${i}`).join('\n'), 'toast.triggerWords.tooMany'],
    [Array(501).fill('word').join(' '), 'toast.triggerWords.tooLong'],
  ])('rejects invalid input without overwriting metadata', async (value, key) => {
    enterWords(value);
    await bulk.saveBulkTriggerWords();
    expect(saveModelMetadataMock).not.toHaveBeenCalled();
    expect(closeModalMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(key, {}, 'warning');
  });

  it('does not write after the modal is cancelled', async () => {
    enterWords('style');
    closeModalMock('bulkTriggerWordsModal');
    await bulk.saveBulkTriggerWords();
    expect(saveModelMetadataMock).not.toHaveBeenCalled();
  });

  it('warns when no model is selected', () => {
    stateStub.selectedModels.clear();
    bulk.showBulkTriggerWordsModal();
    expect(showModalMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith('toast.models.noModelsSelected', {}, 'warning');
  });

  it.each(['recipes', 'checkpoints', 'embeddings', 'other', 'workflows'])(
    'does not offer trigger word editing on %s', async (pageType) => {
      stateStub.currentPageType = pageType;
      bulk.showBulkTriggerWordsModal();
      await bulk.saveBulkTriggerWords();
      expect(showModalMock).not.toHaveBeenCalled();
      expect(saveModelMetadataMock).not.toHaveBeenCalled();
    }
  );
});
