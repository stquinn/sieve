package store

// OwnedAssets writes assets on behalf of the MetaStorable that owns them, for
// every service that holds one.
type OwnedAssets struct {
	Store Store
}

// Save writes data as an asset named assetKey inside owner's directory and
// attaches it to owner's in-memory ownership list, and to the Store's current
// storable for owner when that is a different instance, replacing any asset of
// the same key. Owner's version does not move.
func (o OwnedAssets) Save(owner MetaStorable, assetKey string, data []byte) (AssetStorable, error) {
	asset, err := o.Store.CreateAsset(owner.Category(), owner.Key(), assetKey, data)
	if err != nil {
		return nil, err
	}
	o.attach(owner, asset)
	if current, err := o.Store.LoadByUUID(owner.Key()); err == nil {
		if ms, ok := current.(MetaStorable); ok && ms != owner {
			o.attach(ms, asset)
		}
	}
	return asset, nil
}

func (o OwnedAssets) attach(ms MetaStorable, asset AssetStorable) {
	existing := ms.Owns()
	for i, item := range existing {
		if item.Key() == asset.Key() {
			updated := make([]Storable, len(existing))
			copy(updated, existing)
			updated[i] = asset
			ms.ClearOwns()
			for _, u := range updated {
				ms.AttachAsset(u)
			}
			return
		}
	}
	ms.AttachAsset(asset)
}
