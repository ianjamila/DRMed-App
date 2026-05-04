export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      appointments: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          patient_id: string | null
          scheduled_at: string
          service_id: string | null
          status: string
          walk_in_name: string | null
          walk_in_phone: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          patient_id?: string | null
          scheduled_at: string
          service_id?: string | null
          status?: string
          walk_in_name?: string | null
          walk_in_phone?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          patient_id?: string | null
          scheduled_at?: string
          service_id?: string | null
          status?: string
          walk_in_name?: string | null
          walk_in_phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "appointments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: string
          created_at: string
          id: number
          ip_address: unknown
          metadata: Json | null
          patient_id: string | null
          resource_id: string | null
          resource_type: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: string
          created_at?: string
          id?: number
          ip_address?: unknown
          metadata?: Json | null
          patient_id?: string | null
          resource_id?: string | null
          resource_type?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          id?: number
          ip_address?: unknown
          metadata?: Json | null
          patient_id?: string | null
          resource_id?: string | null
          resource_type?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      clinic_closures: {
        Row: {
          closed_on: string
          created_at: string
          created_by: string | null
          reason: string
        }
        Insert: {
          closed_on: string
          created_at?: string
          created_by?: string | null
          reason: string
        }
        Update: {
          closed_on?: string
          created_at?: string
          created_by?: string | null
          reason?: string
        }
        Relationships: []
      }
      contact_messages: {
        Row: {
          created_at: string
          email: string | null
          handled: boolean
          handled_at: string | null
          handled_by: string | null
          id: string
          ip_address: unknown
          message: string
          name: string
          phone: string | null
          subject: string | null
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          handled?: boolean
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          ip_address?: unknown
          message: string
          name: string
          phone?: string | null
          subject?: string | null
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          handled?: boolean
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          ip_address?: unknown
          message?: string
          name?: string
          phone?: string | null
          subject?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      patients: {
        Row: {
          address: string | null
          birthdate: string
          created_at: string
          created_by: string | null
          drm_id: string
          email: string | null
          first_name: string
          id: string
          last_name: string
          middle_name: string | null
          phone: string | null
          pre_registered: boolean
          sex: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          birthdate: string
          created_at?: string
          created_by?: string | null
          drm_id?: string
          email?: string | null
          first_name: string
          id?: string
          last_name: string
          middle_name?: string | null
          phone?: string | null
          pre_registered?: boolean
          sex?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          birthdate?: string
          created_at?: string
          created_by?: string | null
          drm_id?: string
          email?: string | null
          first_name?: string
          id?: string
          last_name?: string
          middle_name?: string | null
          phone?: string | null
          pre_registered?: boolean
          sex?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount_php: number
          created_at: string
          id: string
          method: string | null
          notes: string | null
          received_at: string
          received_by: string
          reference_number: string | null
          visit_id: string
        }
        Insert: {
          amount_php: number
          created_at?: string
          id?: string
          method?: string | null
          notes?: string | null
          received_at?: string
          received_by: string
          reference_number?: string | null
          visit_id: string
        }
        Update: {
          amount_php?: number
          created_at?: string
          id?: string
          method?: string | null
          notes?: string | null
          received_at?: string
          received_by?: string
          reference_number?: string | null
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      result_template_param_ranges: {
        Row: {
          age_max_months: number | null
          age_min_months: number | null
          band_label: string
          created_at: string
          gender: string | null
          id: string
          parameter_id: string
          ref_high_conv: number | null
          ref_high_si: number | null
          ref_low_conv: number | null
          ref_low_si: number | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          age_max_months?: number | null
          age_min_months?: number | null
          band_label: string
          created_at?: string
          gender?: string | null
          id?: string
          parameter_id: string
          ref_high_conv?: number | null
          ref_high_si?: number | null
          ref_low_conv?: number | null
          ref_low_si?: number | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          age_max_months?: number | null
          age_min_months?: number | null
          band_label?: string
          created_at?: string
          gender?: string | null
          id?: string
          parameter_id?: string
          ref_high_conv?: number | null
          ref_high_si?: number | null
          ref_low_conv?: number | null
          ref_low_si?: number | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "result_template_param_ranges_parameter_id_fkey"
            columns: ["parameter_id"]
            isOneToOne: false
            referencedRelation: "result_template_params"
            referencedColumns: ["id"]
          },
        ]
      }
      result_template_params: {
        Row: {
          abnormal_values: string[] | null
          allowed_values: string[] | null
          created_at: string
          gender: string | null
          id: string
          input_type: string
          is_section_header: boolean
          parameter_name: string
          placeholder: string | null
          ref_high_conv: number | null
          ref_high_si: number | null
          ref_low_conv: number | null
          ref_low_si: number | null
          section: string | null
          si_to_conv_factor: number | null
          sort_order: number
          template_id: string
          unit_conv: string | null
          unit_si: string | null
        }
        Insert: {
          abnormal_values?: string[] | null
          allowed_values?: string[] | null
          created_at?: string
          gender?: string | null
          id?: string
          input_type: string
          is_section_header?: boolean
          parameter_name: string
          placeholder?: string | null
          ref_high_conv?: number | null
          ref_high_si?: number | null
          ref_low_conv?: number | null
          ref_low_si?: number | null
          section?: string | null
          si_to_conv_factor?: number | null
          sort_order: number
          template_id: string
          unit_conv?: string | null
          unit_si?: string | null
        }
        Update: {
          abnormal_values?: string[] | null
          allowed_values?: string[] | null
          created_at?: string
          gender?: string | null
          id?: string
          input_type?: string
          is_section_header?: boolean
          parameter_name?: string
          placeholder?: string | null
          ref_high_conv?: number | null
          ref_high_si?: number | null
          ref_low_conv?: number | null
          ref_low_si?: number | null
          section?: string | null
          si_to_conv_factor?: number | null
          sort_order?: number
          template_id?: string
          unit_conv?: string | null
          unit_si?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "result_template_params_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "result_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      result_templates: {
        Row: {
          created_at: string
          footer_notes: string | null
          header_notes: string | null
          id: string
          is_active: boolean
          layout: string
          service_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          footer_notes?: string | null
          header_notes?: string | null
          id?: string
          is_active?: boolean
          layout: string
          service_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          footer_notes?: string | null
          header_notes?: string | null
          id?: string
          is_active?: boolean
          layout?: string
          service_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "result_templates_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: true
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      result_values: {
        Row: {
          created_at: string
          flag: string | null
          id: string
          is_blank: boolean
          numeric_value_conv: number | null
          numeric_value_si: number | null
          parameter_id: string
          result_id: string
          select_value: string | null
          text_value: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          flag?: string | null
          id?: string
          is_blank?: boolean
          numeric_value_conv?: number | null
          numeric_value_si?: number | null
          parameter_id: string
          result_id: string
          select_value?: string | null
          text_value?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          flag?: string | null
          id?: string
          is_blank?: boolean
          numeric_value_conv?: number | null
          numeric_value_si?: number | null
          parameter_id?: string
          result_id?: string
          select_value?: string | null
          text_value?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "result_values_parameter_id_fkey"
            columns: ["parameter_id"]
            isOneToOne: false
            referencedRelation: "result_template_params"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "result_values_result_id_fkey"
            columns: ["result_id"]
            isOneToOne: false
            referencedRelation: "results"
            referencedColumns: ["id"]
          },
        ]
      }
      results: {
        Row: {
          control_no: number | null
          created_at: string
          file_size_bytes: number | null
          finalised_at: string | null
          generation_kind: string
          id: string
          notes: string | null
          storage_path: string | null
          test_request_id: string
          updated_at: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          control_no?: number | null
          created_at?: string
          file_size_bytes?: number | null
          finalised_at?: string | null
          generation_kind?: string
          id?: string
          notes?: string | null
          storage_path?: string | null
          test_request_id: string
          updated_at?: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          control_no?: number | null
          created_at?: string
          file_size_bytes?: number | null
          finalised_at?: string | null
          generation_kind?: string
          id?: string
          notes?: string | null
          storage_path?: string | null
          test_request_id?: string
          updated_at?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "results_test_request_id_fkey"
            columns: ["test_request_id"]
            isOneToOne: true
            referencedRelation: "test_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      service_price_history: {
        Row: {
          change_reason: string | null
          changed_by: string | null
          effective_from: string
          hmo_price_php: number | null
          id: number
          price_php: number | null
          senior_discount_php: number | null
          service_id: string
        }
        Insert: {
          change_reason?: string | null
          changed_by?: string | null
          effective_from?: string
          hmo_price_php?: number | null
          id?: never
          price_php?: number | null
          senior_discount_php?: number | null
          service_id: string
        }
        Update: {
          change_reason?: string | null
          changed_by?: string | null
          effective_from?: string
          hmo_price_php?: number | null
          id?: never
          price_php?: number | null
          senior_discount_php?: number | null
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_price_history_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          code: string
          created_at: string
          description: string | null
          hmo_price_php: number | null
          id: string
          is_active: boolean
          is_send_out: boolean
          kind: string
          name: string
          price_php: number
          requires_signoff: boolean
          section: string | null
          send_out_lab: string | null
          senior_discount_php: number | null
          turnaround_hours: number | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          hmo_price_php?: number | null
          id?: string
          is_active?: boolean
          is_send_out?: boolean
          kind?: string
          name: string
          price_php: number
          requires_signoff?: boolean
          section?: string | null
          send_out_lab?: string | null
          senior_discount_php?: number | null
          turnaround_hours?: number | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          hmo_price_php?: number | null
          id?: string
          is_active?: boolean
          is_send_out?: boolean
          kind?: string
          name?: string
          price_php?: number
          requires_signoff?: boolean
          section?: string | null
          send_out_lab?: string | null
          senior_discount_php?: number | null
          turnaround_hours?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      staff_profiles: {
        Row: {
          created_at: string
          full_name: string
          id: string
          is_active: boolean
          prc_license_kind: string | null
          prc_license_no: string | null
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id: string
          is_active?: boolean
          prc_license_kind?: string | null
          prc_license_no?: string | null
          role: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          is_active?: boolean
          prc_license_kind?: string | null
          prc_license_no?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      test_requests: {
        Row: {
          assigned_to: string | null
          cancelled_reason: string | null
          completed_at: string | null
          created_at: string
          id: string
          released_at: string | null
          released_by: string | null
          requested_at: string
          requested_by: string
          service_id: string
          signed_off_at: string | null
          signed_off_by: string | null
          started_at: string | null
          status: string
          updated_at: string
          visit_id: string
        }
        Insert: {
          assigned_to?: string | null
          cancelled_reason?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          released_at?: string | null
          released_by?: string | null
          requested_at?: string
          requested_by: string
          service_id: string
          signed_off_at?: string | null
          signed_off_by?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          visit_id: string
        }
        Update: {
          assigned_to?: string | null
          cancelled_reason?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          released_at?: string | null
          released_by?: string | null
          requested_at?: string
          requested_by?: string
          service_id?: string
          signed_off_at?: string | null
          signed_off_by?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_requests_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_requests_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      visit_pins: {
        Row: {
          created_at: string
          expires_at: string
          failed_attempts: number
          id: string
          last_used_at: string | null
          locked_until: string | null
          pin_hash: string
          visit_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          failed_attempts?: number
          id?: string
          last_used_at?: string | null
          locked_until?: string | null
          pin_hash: string
          visit_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          failed_attempts?: number
          id?: string
          last_used_at?: string | null
          locked_until?: string | null
          pin_hash?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visit_pins_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: true
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      visits: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          paid_php: number
          patient_id: string
          payment_status: string
          total_php: number
          updated_at: string
          visit_date: string
          visit_number: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          paid_php?: number
          patient_id: string
          payment_status?: string
          total_php?: number
          updated_at?: string
          visit_date?: string
          visit_number?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          paid_php?: number
          patient_id?: string
          payment_status?: string
          total_php?: number
          updated_at?: string
          visit_date?: string
          visit_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "visits_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_patient_id: { Args: never; Returns: string }
      generate_drm_id: { Args: never; Returns: string }
      generate_visit_number: { Args: never; Returns: string }
      has_role: { Args: { roles: string[] }; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      set_patient_context: {
        Args: { p_patient_id: string }
        Returns: undefined
      }
      staff_role: { Args: never; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
