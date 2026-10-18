using {aaml.mc as db} from '../../db/schema';

extend service MaterialConsumptionService {

    @readonly
    entity SharedConsumptions as projection on db.SharedConsumptions;

    type NursingMaterial {
        Material    : String;
        Description : String;
        BUOM        : String;
        Available   : Decimal(15, 3);
    }

    type SharedAssignment {
        Plant           : String;
        StorageLocation : String;
        CostCenter      : String;
        Message         : String;
    }

    type SharedItemInput {
        Material : String;
        Quantity : Decimal(15, 3);
        BUOM     : String;
    }

    type SharedInput {
        PostingDate     : Date;
        Hospital        : String;
        Modality        : String;
        ClientRequestId : String;
        Items           : many SharedItemInput;
    }

    type SharedItemResult {
        Material                : String;
        Status                  : String;
        Message                 : String;
        SAPMaterialDocumentItem : String;
    }

    type SharedResult {
        Status                  : String;
        Message                 : String;
        SAPMaterialDocument     : String;
        SAPMaterialDocumentYear : String;
        Items                   : many SharedItemResult;
    }


    function searchNursingMaterials(term: String,
                                    hospital: String,
                                    modality: String) returns many NursingMaterial;

    function deriveSharedAssignment(hospital: String,
                                    modality: String) returns SharedAssignment;

    action   validateShared(input: SharedInput)       returns SharedResult;

    action   postShared(input: SharedInput)           returns SharedResult;

}
