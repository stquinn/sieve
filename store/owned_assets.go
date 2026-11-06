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
	o.attachEverywhere(owner, asset)
	return asset, nil
}

// Append appends data to the asset assetKey inside owner's directory, creating
// it when absent, and leaves the ownership lists as Save does. Owner's version
// does not move.
func (o OwnedAssets) Append(owner MetaStorable, assetKey string, data []byte) (AssetStorable, error) {
	asset, err := o.Store.AppendAsset(owner.Category(), owner.Key(), assetKey, data)
	if err != nil {
		return nil, err
	}
	o.attachEverywhere(owner, asset)
	return asset, nil
}

// attachEverywhere attaches asset to owner and to the Store's current storable
// for owner when that is a different instance.
func (o OwnedAssets) attachEverywhere(owner MetaStorable, asset AssetStorable) {
	owner.AttachAsset(asset)
	if current, err := o.Store.LoadByUUID(owner.Key()); err == nil {
		if ms, ok := current.(MetaStorable); ok && ms != owner {
			ms.AttachAsset(asset)
		}
	}
}
