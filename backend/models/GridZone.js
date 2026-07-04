const mongoose = require('mongoose');

/**
 * Module 8.3 — Grid zones.
 *
 * A GridZone is a named, operator-manageable segment of the grid (e.g. a
 * region, feeder, or municipal area). `grid_operator` users are assigned one or
 * more zones via `User.assignedZoneIds` (a list of zone `code` strings) and gain
 * READ-ONLY visibility into every `EnergyNode` whose `zoneId` matches one of
 * their assigned codes. Zone assignment never grants ownership or write access.
 *
 * `code` is the stable, human-readable key referenced by EnergyNode.zoneId and
 * User.assignedZoneIds. It is validated to a safe charset so it can be used
 * directly in Mongo filters without escaping concerns.
 */
const ZONE_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_NAME_LEN = 120;
const MAX_DESC_LEN = 500;

const gridZoneSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Zone code is required'],
      unique: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (v) => ZONE_CODE_RE.test(v),
        message: 'Code must be 1-64 chars of [a-z0-9_-], starting alphanumeric',
      },
    },
    name: {
      type: String,
      required: [true, 'Zone name is required'],
      trim: true,
      maxlength: [MAX_NAME_LEN, `Zone name cannot exceed ${MAX_NAME_LEN} characters`],
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: [MAX_DESC_LEN, `Description cannot exceed ${MAX_DESC_LEN} characters`],
    },
    active: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

gridZoneSchema.index({ active: 1 });

module.exports = mongoose.model('GridZone', gridZoneSchema);
module.exports.ZONE_CODE_RE = ZONE_CODE_RE;
