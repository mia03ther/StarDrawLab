let activeDraft = null;

export const setPhysicalDraft = (draft) => {
  activeDraft = draft || null;
};

export const getPhysicalDraft = () => activeDraft;

export const clearPhysicalDraft = () => {
  activeDraft = null;
};